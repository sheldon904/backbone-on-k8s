# Hermes Agent gateway — the stateful singleton.
#
# This repo does not vendor or fork upstream (NousResearch/hermes-agent) -- it
# clones a pinned tag. It DOES apply one patch, because the running host
# checkout carries one and an image without it does not reproduce the live
# system. Rationale in docs/01-CONTAINERIZATION.md §5.
#
# NOT VERIFIED: this build has never succeeded. The first CI attempt failed on
# a wrong upstream ref (docs/OPERATIONS.md, 2026-07-25). Until CI is green,
# treat every claim about this file as unproven -- VALIDATION.md row C13.

ARG PYTHON_VERSION=3.11-slim

# ---- build ----------------------------------------------------------------
FROM python:${PYTHON_VERSION} AS build

# Pin the upstream tag corresponding to what runs on the live host. Overridable
# so a rebuild moves forward deliberately rather than by drift.
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
# NOT v0.18.0. That is the internal product version `hermes --version` prints;
# upstream tags are date-based. The parenthesised part of
# "Hermes Agent v0.18.0 (2026.7.1)" is the actual tag.
# docs/OPERATIONS.md, 2026-07-25.
ARG HERMES_REF=v2026.7.1

# git for the clone; build-essential because some transitive deps ship sdists
# only. Both stay in the build stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${HERMES_REF}" "${HERMES_REPO}" hermes-agent

# The running host checkout is NOT pristine upstream -- it carries a local patch
# that the Phase 0 audit missed. Applying it here is what makes this image
# reproduce the live system rather than merely resemble it.
#
# `git apply` without --3way, so a patch that no longer applies FAILS THE BUILD.
# A skipped patch is the dangerous case: cron jobs would run with no memory
# access, which produces no crash and no failed probe, just worse agents.
COPY patches/ /src/patches/
RUN set -eu; \
    for p in /src/patches/*.patch; do \
      [ -e "$p" ] || continue; \
      echo "applying $(basename "$p")"; \
      git -C hermes-agent apply --verbose "$p"; \
    done

# Install into a relocatable venv that gets copied wholesale to the runtime
# stage, so build tooling never reaches the final image.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Optional dependency groups: the audit showed the live install using the cron
# scheduler, MCP tool servers, and messaging platforms. Kept explicit rather
# than [all] so the image does not grow a browser stack it will never use.
ARG HERMES_EXTRAS="mcp,cron,messaging,web,cli"
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir "./hermes-agent[${HERMES_EXTRAS}]"

# ---- runtime --------------------------------------------------------------
FROM python:${PYTHON_VERSION}

# A shell survives into this image on purpose. The gateway spawns subprocesses
# as a core feature (the terminal toolset), so distroless is not viable --
# docs/01-CONTAINERIZATION.md §4. Because the shell is here, the pod-level
# securityContext and the NetworkPolicy carry more weight for this workload
# than for any other in the cluster.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 hermes \
 && useradd  --uid 10001 --gid 10001 --create-home --home-dir /home/hermes hermes

COPY --from=build /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/hermes \
    HERMES_HOME=/home/hermes/.hermes

# HERMES_HOME is the single writable path. It is a PVC in Kubernetes and a named
# volume under Compose. Everything else can be a read-only root filesystem.
VOLUME ["/home/hermes/.hermes"]

# The webhook listener. The audit found it bound 0.0.0.0:8645 on the host.
EXPOSE 8645

USER 10001:10001
WORKDIR /home/hermes

# TimeoutStopSec=210 on the host unit exists because the gateway drains
# in-flight conversations for up to 180s before exiting. The Kubernetes
# equivalent is terminationGracePeriodSeconds on the pod, not here -- but the
# reason is recorded here so it does not get "tidied" to 30s by someone reading
# only the manifest.
CMD ["python", "-m", "hermes_cli.main", "gateway", "run"]
