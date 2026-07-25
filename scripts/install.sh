#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Использование: bash scripts/install.sh PATH_TO_SQUADJS [--force]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

target_input=$1
force=false
if [[ ${2:-} == "--force" ]]; then
  force=true
elif [[ $# -eq 2 ]]; then
  usage
  exit 2
fi

if [[ ! -d "$target_input" || ! -f "$target_input/package.json" ]]; then
  echo "Не найден корень SquadJS с package.json: $target_input" >&2
  exit 3
fi

target_root=$(cd "$target_input" && pwd -P)
if [[ "$target_root" == "/" ]]; then
  echo "Корневая файловая система не может быть целью установки." >&2
  exit 3
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source_root=$(cd "$script_dir/../overlay" && pwd -P)
files=(
  "squad-server/plugins/autoseed-exporter.js"
  "squad-server/utils/build-identity.js"
  "squad-server/utils/public-session.js"
)

for relative_path in "${files[@]}"; do
  source_path="$source_root/$relative_path"
  target_path="$target_root/$relative_path"
  if [[ -e "$target_path" ]] && ! cmp -s "$source_path" "$target_path" && [[ "$force" != true ]]; then
    echo "Файл отличается и не будет заменён без --force: $relative_path" >&2
    exit 4
  fi
done

for relative_path in "${files[@]}"; do
  source_path="$source_root/$relative_path"
  target_path="$target_root/$relative_path"
  mkdir -p "$(dirname "$target_path")"
  install -m 0644 "$source_path" "$target_path"
  echo "Установлен $relative_path"
done

echo "Готово. Добавьте examples/squadjs-plugin.json в конфигурацию и перезапустите SquadJS."
