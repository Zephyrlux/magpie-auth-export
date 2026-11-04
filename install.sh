#!/bin/sh
set -eu
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v magpie >/dev/null 2>&1; then
  exec magpie plugin add "$plugin_dir"
elif [ -x /Applications/magpie.app/Contents/MacOS/magpie ]; then
  exec /Applications/magpie.app/Contents/MacOS/magpie plugin add "$plugin_dir"
else
  printf '%s\n' '未找到 Magpie。请在 Magpie 的插件页面添加本插件文件夹。' >&2
  exit 1
fi
