'use strict';
'require view';
'require mu300.common as M';

/* AT 终端 -- 专业串口调试风格：深色输出区、行级高亮（命令/OK/错误/数据）、
 * 每条耗时、↑↓ 翻本地历史、右侧会话历史可点选复用、常用命令分组。
 * 每个快捷命令都带中文说明（鼠标悬停显示，手机端长按显示）。
 * 交互：点击快捷命令或会话历史只「填入输入框」，发送需点「发送」按钮或按 Enter
 *       （避免误触直接把 SPIMEI 这类写号命令发出去）。
 * 命令经 rpcd -> T551M nr2；采集器使用 nr6/nr7，拨号与短信事务使用 MM nr1。守卫在后端：
 * 必须 AT 开头、禁止 ";" 级联、AT+SPENGMD=0,1,0 直接拒绝（会锁死 AT 口直到重启）。 */

/* 写号命令里的占位符：芯片只填模板，真实串号由用户替换。
 * 统一在这里定义，避免文案改动时漏改校验逻辑。 */
var PH_RE = /"(改为你的[^"]*)"/;

/* 分组与命令：每个命令为 [ 命令, 中文说明 ]，说明显示在悬停提示里。 */
var GROUPS = [
	[ '基础', [
		[ 'AT', '测试 AT 通道是否连通，正常返回 OK' ],
		[ 'AT+CFUN?', '查询模块功能级别：1=全功能，0=最小功能（射频关闭）' ],
		[ 'AT+CPIN?', '查询 SIM 卡状态：READY 表示已就绪，需 PIN 时会提示' ],
		[ 'AT+CGMR', '查询模块固件版本号' ],
		[ 'AT+CCID', '读取 SIM 卡的 ICCID（卡片序列号）' ],
		[ 'AT+CIMI', '读取 IMSI（国际移动用户识别码）' ],
		[ 'AT+CGSN', '读取 IMEI（设备国际移动设备识别码）' ],
		[ 'AT+CNUM', '查询本机号码（需 SIM 卡支持，多数返回 ERROR）' ]
	] ],
	[ '注册/信号', [
		[ 'AT+CSQ', '查询信号强度：第一个值为 RSSI（0~31，99=未知）' ],
		[ 'AT+CESQ', '查询扩展信号质量：RSRP/RSRQ/SINR 等' ],
		[ 'AT+CEREG?', '查询 4G/5G 网络注册状态：1=已注册本地网，5=已注册漫游' ],
		[ 'AT+C5GREG?', '查询 5G 网络注册状态' ],
		[ 'AT+COPS?', '查询当前运营商（名称、制式、网络代码）' ],
		[ 'AT+CGATT?', '查询分组域（PS）附着状态：1=已附着' ],
		[ 'AT+CGACT?', '查询 PDP 上下文激活状态：1=已激活' ]
	] ],
	[ '承载', [
		[ 'AT+CGDCONT?', '查询 PDP 上下文参数（APN、IP 类型等）' ],
		[ 'AT+CGPADDR=1', '查询 1 号承载分配到的 IP 地址' ],
		[ 'AT+CGCONTRDP=1', '查询 1 号承载的动态参数（IP、DNS、网关）' ],
		[ 'AT+CGEQOSRDP=1', '查询 1 号承载的 QoS 参数（上下行速率等）' ]
	] ],
	[ '工程模式', [
		[ 'AT+SPENGMD=0,6,0', '工程模式：读取 SIM 卡相关信息' ],
		[ 'AT+SPENGMD=0,14,1', '工程模式：读取射频/信道信息' ],
		[ 'AT+SPENGMD=0,6,6', '工程模式：读取 SIM 卡参数（扩展）' ],
		[ 'AT+SPQ5GNCELLEX', '查询当前 5G 服务小区及邻区详细信息' ],
		[ 'AT+SPENDC?', '查询工程模式下的数据采集状态' ],
		[ 'AT+SPTESTMODE?', '查询模块是否处于测试模式' ],
		[ 'AT+SP5GRAN?', '查询 5G 无线接入网络信息' ]
	] ],
	[ 'IMEI 修改', [
		[ 'AT+SPIMEI?', '查询当前 IMEI（串号）' ],
		[ 'AT+SPIMEI=0,"改为你的串号"', '写入 IMEI（串号）：0 表示卡槽 1，请把引号内换成你的 15 位串号' ]
	] ]
];

return view.extend({
	load: function() { return Promise.resolve(); },

	render: function() {
		M.injectCss();
		M.watchSms();
		var root = document.createElement('div');
		root.className = 'mud';
		root.innerHTML = `
<div class="mud-sec" style="margin-top:0">
  <h3>AT 终端</h3>
  <div style="display:flex;flex-direction:column;gap:8px">
    <div style="display:flex;gap:8px">
      <input id="mud-at-cmd" spellcheck="false" autocomplete="off"
        style="flex:1;min-width:0;padding:8px 12px;border:1px solid var(--hairline,var(--border,#ccc));border-radius:var(--radius-base,.5rem);background:var(--surface,var(--background,#fff));color:var(--text,#222);font-family:var(--font-mono,monospace);font-size:.85rem"
        placeholder="AT 命令（↑↓ 翻历史，Enter 发送）"/>
      <button class="mud-btn" id="mud-at-go" style="padding:8px 18px">发送</button>
      <button class="mud-btn" id="mud-at-clear" style="padding:8px 12px">清屏</button>
    </div>
    <div class="mud-at-grid">
      <div class="mud-term" id="mud-at-out"><span class="ln-meta">就绪。
</span></div>
      <div>
        <div class="mud-note" style="margin:0 0 4px">会话历史（点击填入）</div>
        <div class="mud-scroll" id="mud-at-hist" style="font-family:var(--font-mono,monospace);font-size:.74rem"></div>
      </div>
    </div>
    <div class="mud-note" style="margin-top:2px">快捷命令（点击填入输入框，再点「发送」执行；悬停查看说明）</div>
    <div>
      ${GROUPS.map(function(g) {
        return '<div class="mud-note" style="margin:4px 0 2px">' + g[0] + '</div>' +
          '<div class="mud-chiprow" style="margin-top:2px">' +
          g[1].map(function(c) {
            var cmd = c[0], desc = c[1] || '';
            return '<span class="mud-chip" data-desc="' + M.esc(desc) + '" title="' + M.esc(desc) + '">' + M.esc(cmd) + '</span>';
          }).join('') + '</div>';
      }).join('')}
    </div>
    <div id="mud-at-desc" class="mud-note" style="min-height:1.2em;margin-top:6px;color:var(--text-muted,#777)"></div>
  </div>
</div>`;
		M.localize(root);
		this.wire(root);
		this.loadHist();
		M.simSelector(root);
		return root;
	},

	wire: function(root) {
		var self = this;
		this.Q = function(id) { return root.querySelector('#mud-' + id); };
		this.localHist = [];
		this.histIdx = -1;

		var line = function(cls, text) {
			var el = self.Q('at-out');
			var span = document.createElement('span');
			span.className = cls;
			span.textContent = text + '\n';
			el.appendChild(span);
			el.scrollTop = el.scrollHeight;
		};

		this.send = function() {
			var cmd = (self.Q('at-cmd').value || '').trim();
			if (!cmd) return;
			// 占位符没改就发出去，模块只会回 ERROR；就地拦下并提示，别浪费一次写号尝试
			var ph = PH_RE.exec(cmd);
			if (ph) {
				line('ln-err', M.translate('请先把引号里的「改为你的串号」换成真实的 15 位串号再发送'));
				var box = self.Q('at-cmd');
				box.focus();
				try {
					var s = ph.index + 1;
					box.setSelectionRange(s, s + ph[1].length);
				} catch (e) {}
				return;
			}
			self.localHist.push(cmd);
			self.histIdx = self.localHist.length;
			line('ln-cmd', '> ' + cmd);
			var t0 = Date.now();
			L.resolveDefault(M.callAt(cmd)).then(function(r) {
				r = r || {};
				var ms = Date.now() - t0;
				if (r.ok) {
					(r.reply || M.translate('(无输出)')).split('\n').forEach(function(l) {
						if (/^OK$/.test(l)) line('ln-ok', l);
						else if (/ERROR|^NO CARRIER/.test(l)) line('ln-err', l);
						else if (l) line('ln-data', l);
					});
					line('ln-meta', '—— ' + ms + ' ms');
					self.loadHist();
				} else {
					line('ln-err', M.translate('错误：') + (r.error || M.translate('失败')) + (r.busy ? M.translate('（AT 通道正忙，命令未发出）') : ''));
				}
			}, function() { line('ln-err', M.translate('调用失败')); });
			self.Q('at-cmd').value = '';
		};

		this.Q('at-go').onclick = function() { self.send(); };
		this.Q('at-clear').onclick = function() { self.Q('at-out').innerHTML = ''; };
		this.Q('at-cmd').addEventListener('keydown', function(ev) {
			if (ev.key == 'Enter') { ev.preventDefault(); self.send(); }
			else if (ev.key == 'ArrowUp') {
				ev.preventDefault();
				if (self.histIdx > 0) { self.histIdx--; self.Q('at-cmd').value = self.localHist[self.histIdx] || ''; }
			} else if (ev.key == 'ArrowDown') {
				ev.preventDefault();
				if (self.histIdx < self.localHist.length - 1) { self.histIdx++; self.Q('at-cmd').value = self.localHist[self.histIdx] || ''; }
				else { self.histIdx = self.localHist.length; self.Q('at-cmd').value = ''; }
			}
		});
		// 命令点击：只填入输入框（不发送），由「发送」按钮或 Enter 触发
		var showDesc = function(el) {
			var desc = el.getAttribute('data-desc') || '';
			self.Q('at-desc').textContent = desc;
		};
		var fill = function(cmd) {
			var box = self.Q('at-cmd');
			box.value = cmd;
			box.focus();
			// 命令里带占位文字时（如 SPIMEI 的「改为你的串号」），直接选中占位内容，
			// 用户敲键盘就替换掉，不用手工拖选。
			var ph = PH_RE.exec(cmd);
			try {
				if (ph) {
					var s = ph.index + 1;              // 跳过起始引号
					box.setSelectionRange(s, s + ph[1].length);
				} else {
					box.setSelectionRange(cmd.length, cmd.length);  // 否则光标落末尾
				}
			} catch (e) {}
		};
		root.querySelectorAll('.mud-chip').forEach(function(ch) {
			ch.onclick = function() { fill(ch.textContent); };
			ch.addEventListener('mouseenter', function() { showDesc(ch); });
			ch.addEventListener('focus', function() { showDesc(ch); });
			// 手机端：长按显示说明（触屏没有 hover）
			ch.addEventListener('touchstart', function() { showDesc(ch); }, { passive: true });
		});
		this.Q('at-hist').addEventListener('click', function(ev) {
			if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-cmd')) {
				fill(ev.target.getAttribute('data-cmd'));
			}
		});
	},

	loadHist: function() {
		var self = this;
		L.resolveDefault(M.callAtHist()).then(function(r) {
			r = r || {};
			var h = (r.history || '').split('\n').filter(Boolean).slice().reverse();
			self.Q('at-hist').innerHTML = h.length
				? h.map(function(l) {
					var cmd = l.replace(/^[0-9-]+ [0-9:]+ /, '');
					return '<div style="padding:2px 4px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" data-cmd="' + M.esc(cmd) + '" title="' + M.esc(cmd) + '">' + M.esc(cmd) + '</div>';
				}).join('')
				: '<div class="mud-note">' + M.translate('（空）') + '</div>';
		});
	}
});
