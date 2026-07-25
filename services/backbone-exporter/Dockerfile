# backbone-exporter — stdlib Python, so the runtime image is just Python.
#
# No pip install at all: the exporter imports nothing outside the standard
# library. That is deliberate -- prometheus_client would add a dependency tree
# to a service whose entire job is formatting ~30 numbers as text, and this
# image has no package manager surface to keep patched.
FROM python:3.11-slim

RUN groupadd --gid 10002 exporter \
 && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent exporter

COPY exporter.py /app/exporter.py

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BACKBONE_STATE_DIR=/state \
    PORT=9101

EXPOSE 9101
USER 10002:10002

# The state volume is mounted READ-ONLY. The exporter opens every database with
# `file:...?mode=ro`, so it cannot write to the gateway's stores even if the
# mount were writable -- two independent guarantees rather than one.
CMD ["python", "/app/exporter.py"]
