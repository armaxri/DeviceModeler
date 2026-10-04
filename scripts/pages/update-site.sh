#!/usr/bin/env bash
# Updates a checkout of the GitHub Pages site (the branch gh-pages, see .github/workflows/pages.yml):
# puts the web app of one branch into its own folder (or removes the folder of a deleted branch) and writes
# the overview page index.html with one entry per published branch (main first).
#
# Usage: scripts/pages/update-site.sh <site> <branch> <folder> <web app dist | --delete> [<repository> [<commit> [<date>]]]
#   <site>        the checkout of gh-pages (created if missing)
#   <branch>      the branch name shown on the overview page
#   <folder>      its folder in the site (the branch name with "/" and other characters replaced by "-")
#   <web app dist> packages/web/dist of that branch; --delete removes the folder instead
#   <repository>  owner/name for the link to the sources (default armaxri/DeviceModeler)
#   <commit>, <date> shown on the overview page (default: git rev-parse --short HEAD, git log -1 --format=%cs)
#
# The web app is built with relative paths (vite base './'), so it runs in any folder:
#   https://armaxri.github.io/DeviceModeler/<folder>/
#   https://armaxri.github.io/DeviceModeler/<folder>/?example=system.devm   (an example, see packages/web)
set -euo pipefail

if [ $# -lt 4 ]; then
    sed -n '5,12p' "$0" >&2
    exit 2
fi
site=$1
branch=$2
folder=$3
dist=$4
repository=${5:-armaxri/DeviceModeler}
commit=${6:-$(git rev-parse --short HEAD)}
date=${7:-$(git log -1 --format=%cs)}

case "$folder" in
    '' | . | .. | */*) echo "invalid folder: '$folder'" >&2; exit 2 ;;
esac

mkdir -p "$site"
rm -rf "${site:?}/$folder"
if [ "$dist" != "--delete" ]; then
    if [ ! -f "$dist/index.html" ]; then
        echo "$dist/index.html is missing: build the web app first (npm run build -w packages/web)" >&2
        exit 1
    fi
    cp -R "$dist" "$site/$folder"
    printf '%s\n%s\n%s\n' "$branch" "$commit" "$date" > "$site/$folder/.branch"
fi
# no Jekyll processing (files and folders starting with _ are served as they are)
touch "$site/.nojekyll"

html() {
    local text=$1
    text=${text//&/&amp;}
    text=${text//</&lt;}
    text=${text//>/&gt;}
    text=${text//\"/&quot;}
    printf '%s' "$text"
}

# the examples linked for every branch: file name of packages/web/src/examples.ts -> label
examples=(
    'system.devm|Garage installation (structure diagram)'
    'garage-door.devm|Garage door subsystem (structure diagram)'
    'traffic-light.devm|Traffic light (state machine)'
    'controller.devm|Garage door controller (state machine)'
)

{
    cat <<'HEAD'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Device Modeler</title>
<style>
:root{color-scheme:light dark;--fg:#222;--bg:#fff;--muted:#666;--accent:#a80036;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--fg:#ddd;--bg:#1e1e1e;--muted:#999;--accent:#ff7a9c;--line:#3a3a3a}}
body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:var(--fg);background:var(--bg);line-height:1.45}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
ul.branches{list-style:none;padding:0}
ul.branches>li{border-top:1px solid var(--line);padding:.8rem 0}
.branch{font-weight:600;font-size:1.05rem}
small{color:var(--muted)}
.examples{margin:.3rem 0 0;padding-left:1.2rem}
.examples li{margin:.15rem 0}
</style>
</head>
<body>
<h1>Device Modeler</h1>
<p>Product structures (components, ports, subsystems, threads) and hierarchical state machines with diagrams,
simulation and C++ code generation. The web app of each branch runs in the browser; your edits stay in this browser.</p>
HEAD
    printf '<p><a href="https://github.com/%s">Sources on GitHub</a></p>\n' "$(html "$repository")"
    echo '<ul class="branches">'
    # main first, then the other branches (alphabetical by folder)
    metas=()
    [ -f "$site/main/.branch" ] && metas+=("$site/main/.branch")
    for meta in "$site"/*/.branch; do
        [ -f "$meta" ] || continue
        [ "$meta" = "$site/main/.branch" ] && continue
        metas+=("$meta")
    done
    for meta in ${metas[@]+"${metas[@]}"}; do
        dir=$(basename "$(dirname "$meta")")
        name=$(sed -n 1p "$meta")
        sha=$(sed -n 2p "$meta")
        day=$(sed -n 3p "$meta")
        printf '<li><a class="branch" href="./%s/">%s</a> <small>%s · %s</small>\n' \
            "$(html "$dir")" "$(html "$name")" "$(html "$sha")" "$(html "$day")"
        echo '<ul class="examples">'
        for example in "${examples[@]}"; do
            printf '<li><a href="./%s/?example=%s">%s</a></li>\n' "$(html "$dir")" "${example%%|*}" "$(html "${example#*|}")"
        done
        echo '</ul></li>'
    done
    echo '</ul>'
    echo '</body>'
    echo '</html>'
} > "$site/index.html"
