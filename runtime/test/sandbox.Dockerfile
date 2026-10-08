# Small smoke image to verify bubblewrap separately from ML dependencies.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 engine
USER engine
CMD ["bwrap", "--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true"]
