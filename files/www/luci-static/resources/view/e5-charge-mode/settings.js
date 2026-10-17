'use strict';
'require form';
'require view';

return view.extend({
	render: function () {
		var m = new form.Map('e5-charge-mode', _('充电模式'),
			_('控制"插着充电器开机"时的行为。仅影响充电器触发的这一次启动，不影响正常按键开机。'));

		var s = m.section(form.NamedSection, 'main', 'main', _('设置'));
		s.addremove = false;
		s.anonymous = false;

		var o = s.option(form.Flag, 'enabled', _('插充电器时直接进入 OpenWrt'),
			_('开启（默认）：插着充电器开机时直接进入 OpenWrt 系统，与正常开机一致。<br />' +
			  '关闭：插着充电器开机时停在充电界面，长按电源键 1.5 秒后继续启动。'));
		o.default = '1';
		o.rmempty = false;

		return m.render();
	}
});
