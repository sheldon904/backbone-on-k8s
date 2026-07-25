{{/* Name helpers */}}
{{- define "backbone.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "backbone.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "backbone.namespace" -}}
{{- default .Release.Namespace .Values.namespace.name -}}
{{- end -}}

{{- define "backbone.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/part-of: backbone
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{/* Image reference. Gateway tag falls back to appVersion so the chart and the
     hermes-agent release it was built against cannot drift silently. */}}
{{- define "backbone.image" -}}
{{- $top := index . 0 -}}
{{- $img := index . 1 -}}
{{- $registry := default $top.Values.image.registry $img.registry -}}
{{- $repo := default $top.Values.image.repository $img.repository -}}
{{- $tag := default $top.Chart.AppVersion $img.tag -}}
{{- printf "%s/%s/%s:%s" $registry $repo $img.name $tag -}}
{{- end -}}

{{/* Pod-level securityContext shared by every workload. Satisfies the
     `restricted` Pod Security Standard. */}}
{{- define "backbone.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .runAsUser }}
runAsGroup: {{ .runAsGroup }}
fsGroup: {{ .fsGroup }}
fsGroupChangePolicy: OnRootMismatch
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Container-level securityContext. readOnlyRootFilesystem is a parameter
     because the gateway's tolerance of it is unverified (VALIDATION.md C11). */}}
{{- define "backbone.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .readOnlyRootFilesystem | default true }}
runAsNonRoot: true
capabilities:
  drop: ["ALL"]
{{- end -}}
