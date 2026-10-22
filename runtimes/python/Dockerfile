# FF function runtime for Python (runtime protocol v3).
# Build:  docker build -t ff-runtime-python:3.13-v3 runtimes/python
# The runtime uses only the standard library, and nothing is installed when a
# function starts: functions ship their dependencies in their package, as on
# AWS Lambda. Debian (glibc), so manylinux wheels built for Lambda work.
FROM python:3.13-slim
LABEL org.opencontainers.image.title="ff-runtime-python" \
      org.opencontainers.image.description="FF function runtime for Python, protocol v3"
WORKDIR /opt/ff
COPY ff_runtime ./ff_runtime
# The root filesystem is read-only at run time, so compile the runtime now.
RUN python -m compileall -q ff_runtime
# pip, which nothing here runs: functions ship their dependencies in their package, and nothing can be installed
# on a read-only root. The packages pip vendors carry advisories that the image scan reports (hack/ci.sh).
RUN python -m pip uninstall -y -q pip && rm -rf /usr/local/lib/python3.13/ensurepip
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/ff \
    LAMBDA_TASK_ROOT=/var/task \
    FF_HANDLER=function.handler \
    PORT=8080
# Non-root, numeric so Kubernetes runAsNonRoot can verify it.
USER 10001:10001
EXPOSE 8080
CMD ["python", "-P", "-m", "ff_runtime.main"]
