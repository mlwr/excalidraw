{{/* Chart name, truncated for Kubernetes name limits */}}
{{- define "excalidraw.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "excalidraw.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "excalidraw.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "excalidraw.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "excalidraw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "excalidraw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "excalidraw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "excalidraw.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* secret created by this chart for inline credentials */}}
{{- define "excalidraw.secretName" -}}
{{- printf "%s-secrets" (include "excalidraw.fullname" .) -}}
{{- end -}}

{{- define "excalidraw.postgresqlName" -}}
{{- printf "%s-postgresql" (include "excalidraw.fullname" .) -}}
{{- end -}}

{{- define "excalidraw.host" -}}
{{- default (urlParse .Values.publicUrl).host .Values.ingress.host -}}
{{- end -}}

{{/* whether realtime rooms must be shared across pods */}}
{{- define "excalidraw.realtimeCluster" -}}
{{- $mode := toString .Values.realtime.cluster -}}
{{- if eq $mode "auto" -}}
{{- if or .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1) -}}true{{- else -}}false{{- end -}}
{{- else -}}
{{- $mode -}}
{{- end -}}
{{- end -}}

{{/* the chart's own secret is needed when any credential is given inline */}}
{{- define "excalidraw.needsSecret" -}}
{{- if or (and .Values.oidc.clientSecret (not .Values.oidc.existingSecret)) (and .Values.database.url (not .Values.database.existingSecret)) .Values.postgresql.enabled (and (eq .Values.storage.driver "s3") (not .Values.storage.s3.existingSecret)) (and .Values.encryption.key (not .Values.encryption.existingSecret)) (and .Values.ai.apiKey (not .Values.ai.existingSecret)) (and .Values.smtp.password (not .Values.smtp.existingSecret)) -}}true{{- end -}}
{{- end -}}
