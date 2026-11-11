import { useEffect, useMemo, useState } from "react";

import { workspaceApi } from "../intranet/workspaceApi";

import { Avatar, Button, ROLE_LABELS } from "./ui";

import type { DirectoryResult, Grant } from "../intranet/workspaceApi";

type GrantRole = Grant["role"];

/**
 * Edit who has access: people (users who logged in at least once) and
 * Keycloak groups, each with a role.
 */
export const AccessEditor = ({
  grants,
  onChange,
  roles,
  disabled,
}: {
  grants: Grant[];
  onChange: (grants: Grant[]) => void;
  roles: GrantRole[];
  disabled?: boolean;
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryResult>({
    users: [],
    groups: [],
  });
  const [newRole, setNewRole] = useState<GrantRole>(roles[0]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults({ users: [], groups: [] });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      workspaceApi
        .directory(q)
        .then((found) => {
          if (!cancelled) {
            setResults(found);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults({ users: [], groups: [] });
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const existing = useMemo(
    () => new Set(grants.map((grant) => `${grant.type}:${grant.principal}`)),
    [grants],
  );

  const add = (grant: Omit<Grant, "role">) => {
    if (!existing.has(`${grant.type}:${grant.principal}`)) {
      onChange([...grants, { ...grant, role: newRole }]);
    }
    setQuery("");
  };

  const suggestions = [
    ...results.users.map((user) => ({
      key: `user:${user.id}`,
      grant: { type: "user" as const, principal: user.id, label: user.name },
      detail: user.email || user.username || "",
    })),
    ...results.groups.map((group) => ({
      key: `group:${group}`,
      grant: { type: "group" as const, principal: group, label: group },
      detail: "Gruppe aus Keycloak",
    })),
  ].filter((item) => !existing.has(item.key));

  return (
    <div className="ws-access">
      {!disabled && (
        <div className="ws-access__add">
          <div className="ws-access__search">
            <input
              className="ws-input"
              type="search"
              placeholder="Person oder Gruppe suchen …"
              aria-label="Person oder Gruppe suchen"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {suggestions.length > 0 && (
              <ul className="ws-access__suggestions" role="listbox">
                {suggestions.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => add(item.grant)}
                    >
                      {item.grant.type === "user" ? (
                        <Avatar
                          id={item.grant.principal}
                          name={item.grant.label}
                        />
                      ) : (
                        <span className="ws-group-badge">G</span>
                      )}
                      <span className="ws-access__suggestion-text">
                        <strong>{item.grant.label}</strong>
                        <small>{item.detail}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <select
            className="ws-input ws-access__role"
            aria-label="Rolle für neue Einträge"
            value={newRole}
            onChange={(event) => setNewRole(event.target.value as GrantRole)}
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
      )}

      {grants.length === 0 ? (
        <p className="ws-muted">Noch niemand eingetragen.</p>
      ) : (
        <ul className="ws-access__list">
          {grants.map((grant) => (
            <li key={`${grant.type}:${grant.principal}`}>
              {grant.type === "user" ? (
                <Avatar id={grant.principal} name={grant.label} />
              ) : (
                <span className="ws-group-badge">G</span>
              )}
              <span className="ws-access__label">
                {grant.label}
                {grant.type === "group" && <small> · Gruppe</small>}
              </span>
              <select
                className="ws-input ws-access__role"
                aria-label={`Rolle von ${grant.label}`}
                value={grant.role}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    grants.map((item) =>
                      item === grant
                        ? { ...item, role: event.target.value as GrantRole }
                        : item,
                    ),
                  )
                }
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
              {!disabled && (
                <Button
                  variant="ghost"
                  aria-label={`${grant.label} entfernen`}
                  onClick={() =>
                    onChange(grants.filter((item) => item !== grant))
                  }
                >
                  Entfernen
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
