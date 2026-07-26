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

# The read-only guarantee is at the CONNECTION level: every database is opened
# with `file:...?mode=ro`, which SQLite enforces. The volume mount itself cannot
# be readOnly -- a WAL-mode reader must be able to create the `-shm` coordination
# file, and a readOnly mount makes every open fail with
# "unable to open database file". See charts/.../exporter.yaml.
CMD ["python", "/app/exporter.py"]
