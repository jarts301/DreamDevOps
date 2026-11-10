#!/bin/sh
# Runs Helm against the local target. Pass the dashboard's connect command without the
# leading "helm". The local registry speaks plain HTTP, and the agent must be told so.
set -eu
mkdir -p /root/.kube
sed 's#https://127.0.0.1:6443#https://k3s:6443#' /k3s/kubeconfig.yaml > /root/.kube/config
case "${1:-}" in
  install|upgrade)
    exec helm "$@" --plain-http --set insecureRegistry=true
    ;;
  *)
    exec helm "$@"
    ;;
esac
