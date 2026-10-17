#!/bin/sh
# E5 增强包 — 设备端热更新安装脚本（整合版）
#
# 一次装好两项改动：
#   A. 充电模式开关：LuCI → 服务 → 充电模式（控制插充电器开机行为）
#   B. AT 终端增强：新增 IMEI 命令 + 每条命令的中文说明
#
# 用法（在 E5 上以 root 运行）：
#   sh install.sh              安装/更新两项
#   sh install.sh --charge     只装充电模式开关
#   sh install.sh --at         只装 AT 终端增强
#   sh install.sh --uninstall  卸载两项（AT 页面自动还原备份）
#
# 特性：只写 rootfs 用户态文件，不重启系统、不动内核、不改分区表。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
FILES="$HERE/files"

CHARGE_TARGETS='etc/config/e5-charge-mode
etc/init.d/e5-charge-mode
etc/uci-defaults/98-e5-charge-mode
usr/libexec/e5-charge-mode
usr/share/luci/menu.d/luci-app-e5-charge-mode.json
usr/share/rpcd/acl.d/luci-app-e5-charge-mode.json
www/luci-static/resources/view/e5-charge-mode/settings.js'

AT_TARGET='www/luci-static/resources/view/mu300/at.js'
BACKUP_PATH=/tmp/e5-hotupdate-at-backup.path
REGISTRY=/tmp/e5-hotupdate.installed

[ -d "$FILES" ] || { echo "error: 缺少 files/ 目录，请在解压后的目录里运行" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "error: 需要 root 权限运行" >&2; exit 1; }

log() { echo "== $*"; }

do_charge() {
    log "A. 安装充电模式开关 / charger-mode switch"
    : > "$REGISTRY"
    for rel in $CHARGE_TARGETS; do
        src="$FILES/$rel"; dst="/$rel"
        [ -e "$src" ] || { echo "  skip (missing): $rel"; continue; }
        # 已存在的 UCI 配置不覆盖，保留用户设置
        if [ "$rel" = "etc/config/e5-charge-mode" ] && [ -f "$dst" ]; then
            echo "  保留已有配置: $dst"
            echo "$dst" >> "$REGISTRY"
            continue
        fi
        mkdir -p "$(dirname "$dst")"
        cp -f "$src" "$dst"
        echo "$dst" >> "$REGISTRY"
        echo "  + $dst"
    done

    [ -f /usr/libexec/e5-charge-mode ] && chmod 0755 /usr/libexec/e5-charge-mode
    [ -f /etc/init.d/e5-charge-mode ] && chmod 0755 /etc/init.d/e5-charge-mode
    [ -f /etc/uci-defaults/98-e5-charge-mode ] && chmod 0755 /etc/uci-defaults/98-e5-charge-mode

    # 注册自启（rc.common enable 需要 ubus；镜像构建期同样直接做软链）
    [ -e /etc/rc.d/S14e5-charge-mode ] || \
        ln -sf ../init.d/e5-charge-mode /etc/rc.d/S14e5-charge-mode

    # 首次写入默认值（选项缺失时才写）
    uci -q get e5-charge-mode.main.enabled >/dev/null 2>&1 || {
        uci set e5-charge-mode.main=main
        uci set e5-charge-mode.main.enabled='1'
        uci commit e5-charge-mode
    }
    echo "  ✓ 充电模式开关已就绪（默认 enabled=1：插充电器直接进系统）"
}

do_at() {
    log "B. 安装 AT 终端增强 / AT terminal enhancement"
    src="$FILES/$AT_TARGET"; dst="/$AT_TARGET"
    [ -e "$src" ] || { echo "  skip (missing): $AT_TARGET"; return; }

    # 只在第一次安装时备份，避免重复更新把"原始版本"覆盖掉；
    # 这样 --uninstall 永远能回到最初的官方页面。
    if [ -f "$dst" ] && [ ! -f "$BACKUP_PATH" ]; then
        b="/root/at.js.bak.$(date +%Y%m%d-%H%M%S)"
        cp -p "$dst" "$b"
        echo "$b" > "$BACKUP_PATH"
        echo "  已备份原页面: $dst -> $b"
    elif [ -f "$BACKUP_PATH" ]; then
        echo "  已存在原始备份，保留: $(cat "$BACKUP_PATH")"
    fi
    mkdir -p "$(dirname "$dst")"
    cp -f "$src" "$dst"
    chmod 0644 "$dst"
    echo "  + $dst"
    echo "  ✓ AT 终端已更新（新增 IMEI 分组 + 全部命令中文说明）"
}

do_uninstall() {
    log "卸载 / uninstalling"

    # A. 充电模式：删文件与软链（保留 /etc/config 以免误删设置）
    if [ -f "$REGISTRY" ]; then
        while read -r p; do
            [ -n "$p" ] || continue
            # 保留 UCI 配置：卸载只撤代码，不动用户设置
            case "$p" in
                */etc/config/e5-charge-mode) echo "  保留配置（未删）: $p" ;;
                *) rm -f "$p" && echo "  - $p" ;;
            esac
        done < "$REGISTRY"
        rm -f "$REGISTRY"
    else
        for rel in $CHARGE_TARGETS; do
            case "$rel" in
                etc/config/e5-charge-mode) echo "  保留配置（未删）: /$rel" ;;
                *) rm -f "/$rel" ;;
            esac
        done
        rm -f "$REGISTRY"
    fi
    rm -f /etc/rc.d/S14e5-charge-mode
    rmdir /www/luci-static/resources/view/e5-charge-mode 2>/dev/null || true

    # B. AT 页面：还原备份
    dst="/$AT_TARGET"
    if [ -f "$BACKUP_PATH" ] && [ -f "$(cat "$BACKUP_PATH")" ]; then
        b=$(cat "$BACKUP_PATH")
        cp -f "$b" "$dst"
        echo "  已还原 AT 页面: $b -> $dst"
        rm -f "$BACKUP_PATH"
    else
        echo "  AT 页面无备份可还原（如需要，请从原厂包或镜像重新取回）"
    fi

    rm -f /tmp/luci-indexcache* 2>/dev/null || true
    /etc/init.d/rpcd reload 2>/dev/null || true
    echo "已卸载"
}

refresh_luci() {
    log "刷新 LuCI 缓存 / reloading rpcd"
    rm -f /tmp/luci-indexcache* 2>/dev/null || true
    /etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null || true
    /etc/init.d/uhttpd reload 2>/dev/null || true
}

case "${1:-}" in
    --uninstall) do_uninstall ;;
    --charge)    do_charge; refresh_luci; echo; echo "完成。充电模式生效需重启一次：reboot" ;;
    --at)        do_at; refresh_luci; echo; echo "完成。请在浏览器按 Ctrl+F5 强制刷新后打开 AT 终端" ;;
    "")
        do_charge
        do_at
        refresh_luci
        echo
        log "全部完成 / done"
        echo
        echo "① 充电模式：LuCI → 服务 → 充电模式"
        echo "   当前值 $(uci -q get e5-charge-mode.main.enabled 2>/dev/null || echo '1') （1=插充电器直进系统，0=停在充电界面）"
        echo "   ⚠ 该项需 reboot 后生效"
        echo
        echo "② AT 终端：浏览器按 Ctrl+F5 强制刷新后打开，可见"
        echo "   新增「IMEI 修改」分组（AT+SPIMEI? / AT+SPIMEI=0,\"...\"）"
        echo "   以及每条快捷命令的中文说明（悬停/长按显示）"
        echo
        echo "回滚：sh install.sh --uninstall"
        ;;
    *)
        echo "用法: sh install.sh [--charge|--at|--uninstall]" >&2
        exit 1
        ;;
esac
