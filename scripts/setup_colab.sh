#!/usr/bin/env bash
# Snapfix Colab / own-GPU setup: Qwen2-VL via vLLM + tenant HTTP server.
#
# Matches [tool.malex] in pyproject.toml (no Malex platform required).
#
# Colab notebook usage:
#   Runtime → Change runtime type → GPU (T4/L4/A100 recommended)
#   !git clone <your-repo-url> malexai-platform   # or upload/unzip project
#   %cd malexai-platform/examples/snapfix
#   !bash scripts/setup_colab.sh
#
# Optional: set HF_TOKEN or HUGGING_FACE_HUB_TOKEN for gated HuggingFace models.
# OOM on Colab T4 (16GB): lower before running, e.g.:
#   export VLLM_GPU_MEMORY_UTILIZATION=0.75
#   export VLLM_MAX_MODEL_LEN=16384
#
# Prerequisites: copy .env.example → .env and set GOOGLE_PLACES_API_KEY for full
# POST /snapfix/contractors (vision works without it; Places step needs the key).

set -euo pipefail

SNAPFIX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${SNAPFIX_ROOT}"

# Defaults aligned with pyproject.toml [tool.malex] — override via env.
MALEX_MODEL="${MALEX_MODEL:-Qwen/Qwen2-VL-7B-Instruct}"
VLLM_SERVED_MODEL_NAME="${VLLM_SERVED_MODEL_NAME:-snapfix-qwen-vl}"
VLLM_INTERNAL_PORT="${VLLM_INTERNAL_PORT:-3001}"
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-32768}"
VLLM_GPU_MEMORY_UTILIZATION="${VLLM_GPU_MEMORY_UTILIZATION:-0.82}"
MALEX_TENANT_HTTP_PORT="${MALEX_TENANT_HTTP_PORT:-8790}"

VLLM_HEALTH_TIMEOUT_SEC="${VLLM_HEALTH_TIMEOUT_SEC:-900}"
SNAPFIX_HEALTH_TIMEOUT_SEC="${SNAPFIX_HEALTH_TIMEOUT_SEC:-120}"
HEALTH_POLL_SEC="${HEALTH_POLL_SEC:-5}"

VLLM_PID=""
SNAPFIX_PID=""

cleanup() {
  if [[ -n "${SNAPFIX_PID}" ]] && kill -0 "${SNAPFIX_PID}" 2>/dev/null; then
    kill "${SNAPFIX_PID}" 2>/dev/null || true
  fi
  if [[ -n "${VLLM_PID}" ]] && kill -0 "${VLLM_PID}" 2>/dev/null; then
    kill "${VLLM_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1"
  local label="$2"
  local timeout_sec="$3"
  local elapsed=0
  echo "[+] Waiting for ${label} (${url}) — timeout ${timeout_sec}s"
  while (( elapsed < timeout_sec )); do
    if curl -sf "${url}" >/dev/null 2>&1; then
      echo "[+] ${label} is ready."
      return 0
    fi
    sleep "${HEALTH_POLL_SEC}"
    elapsed=$((elapsed + HEALTH_POLL_SEC))
    if (( elapsed % 30 == 0 )); then
      echo "    … still waiting (${elapsed}s)"
    fi
  done
  echo "[!] Timed out waiting for ${label}." >&2
  return 1
}

echo "[+] Snapfix root: ${SNAPFIX_ROOT}"
echo "[+] Model: ${MALEX_MODEL}"
echo "[+] Served name: ${VLLM_SERVED_MODEL_NAME}"
echo "[+] vLLM port: ${VLLM_INTERNAL_PORT} | tenant HTTP: ${MALEX_TENANT_HTTP_PORT}"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "[!] nvidia-smi not found. Use a GPU runtime (Colab: Runtime → Change runtime type → GPU)." >&2
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true

mkdir -p logs

echo "[+] Installing tenant Python dependencies (pip install -e .)..."
pip install -q -e .

if [[ -f .env ]]; then
  echo "[+] Loading .env"
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "[!] No .env — copy .env.example and set GOOGLE_PLACES_API_KEY for Places search."
fi

export VLLM_PORT="${VLLM_INTERNAL_PORT}"
export VLLM_SERVED_MODEL_NAME
export MALEX_SNAPFIX_RERANK_DEVICE="${MALEX_SNAPFIX_RERANK_DEVICE:-cpu}"
export MALEX_TENANT_HTTP_BIND="${MALEX_TENANT_HTTP_BIND:-127.0.0.1}"
export MALEX_TENANT_HTTP_PORT

echo "[+] Starting vLLM (logs: logs/vllm.log)..."
vllm serve "${MALEX_MODEL}" \
  --host 0.0.0.0 \
  --port "${VLLM_INTERNAL_PORT}" \
  --max-model-len "${VLLM_MAX_MODEL_LEN}" \
  --gpu-memory-utilization "${VLLM_GPU_MEMORY_UTILIZATION}" \
  --served-model-name "${VLLM_SERVED_MODEL_NAME}" \
  > logs/vllm.log 2>&1 &
VLLM_PID=$!

wait_for_http "http://127.0.0.1:${VLLM_INTERNAL_PORT}/health" "vLLM" "${VLLM_HEALTH_TIMEOUT_SEC}"

echo "[+] Starting snapfix tenant server (logs: logs/snapfix.log)..."
python3 server/snapfix_server.py > logs/snapfix.log 2>&1 &
SNAPFIX_PID=$!

wait_for_http "http://127.0.0.1:${MALEX_TENANT_HTTP_PORT}/snapfix/health" "snapfix HTTP" "${SNAPFIX_HEALTH_TIMEOUT_SEC}"

PIXELPNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgwJ/lQGTWQAAAABJRU5ErkJggg=='

cat <<EOF

[+] Snapfix stack is running.

  vLLM health:    http://127.0.0.1:${VLLM_INTERNAL_PORT}/health
  Snapfix health: http://127.0.0.1:${MALEX_TENANT_HTTP_PORT}/snapfix/health
  Contractors:    POST http://127.0.0.1:${MALEX_TENANT_HTTP_PORT}/snapfix/contractors

  Logs: logs/vllm.log  logs/snapfix.log

Sample curl (1×1 PNG; needs GOOGLE_PLACES_API_KEY for full pipeline):

  curl -s http://127.0.0.1:${MALEX_TENANT_HTTP_PORT}/snapfix/contractors \\
    -H 'Content-Type: application/json' \\
    -d '{"image_base64":"data:image/png;base64,${PIXELPNG_B64}","location":"Folsom CA 95630"}' | python3 -m json.tool

Processes stay up until this script is interrupted (Ctrl+C / Colab kernel stop).
EOF

# Keep script alive so trap cleanup runs on interrupt.
wait "${VLLM_PID}" "${SNAPFIX_PID}"
