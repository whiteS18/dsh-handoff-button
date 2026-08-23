/**
 * dsh-handoff-button — Client half (browser bundle).
 *
 * Registers one icon button per finalized assistant message inside the
 * `conversation.chat.assistant-actions` action strip (order 100, after the
 * shipped feedback entry at 10). Visual style mirrors the shipped IconActions
 * chrome (copy / branch): a 28x28 round ghost button with a 16px icon, and a
 * real Tooltip (the same primitives Tooltip the copy/branch buttons use).
 *
 * Icon: the "History" icon from Magnific (Freepik), id history_12855621.
 * The icon is served same-origin by the Host route `/handoff/icon` (the packaged
 * `assets/write.png`), rendered through a CSS mask so the glyph follows
 * `currentColor` (theme tokens) with zero external network dependency.
 *
 * States:
 * - idle: history icon — click POSTs to `/handoff/write` (same origin).
 * - busy: dimmed history icon (disabled).
 * - done: green check icon for ~2s, then auto-resets to idle. Clicking in the
 *   done state re-opens the generated file (GET `/handoff/read`) in a new
 *   tab instead of generating again.
 * - error: red warning icon (click retries).
 *
 * This file is a classic script registered through the client module loader:
 * `window.__ModuleLoader__.load({ id, factory })` with a lazy CJS factory.
 * `require` resolves platform seed words (react, @deepseek-ai/... ) and graph
 * rows. The plugin module exports `apply(ctx)` and `inject` (service names).
 */
window.__ModuleLoader__.load({
  id: 'dsh-handoff-button',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { Tooltip, IconCheckOutline16, IconWarningOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');


    const CSS = [
      '.dsh-handoff-btn{width:28px;height:28px;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
      '.dsh-handoff-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#ccc)}',
      '.dsh-handoff-btn[data-state="busy"]{opacity:.5;cursor:wait}',
      '.dsh-handoff-btn[data-state="done"]{color:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.dsh-handoff-btn[data-state="error"]{color:var(--dsw-alias-state-error-primary,#f85149)}',
      '.dsh-handoff-icon{width:16px;height:16px;display:inline-block;flex:none;background-color:currentColor;-webkit-mask:url(\'/handoff/icon\') center/contain no-repeat;mask:url(\'/handoff/icon\') center/contain no-repeat}',
    ].join('\n');

    function injectStyle() {
      const el = document.createElement('style');
      el.setAttribute('data-plugin', 'dsh-handoff-button');
      el.textContent = CSS;
      document.head.append(el);
    }

    // Icon glyph rendered through a CSS mask (color = currentColor); the image is
    // served same-origin by the Host route /handoff/icon (assets/write.png).
    function IconHistory() {
      return React.createElement('span', { className: 'dsh-handoff-icon', 'aria-hidden': true });
    }

    function HandoffButton(props, ctx) {
      const [state, setState] = React.useState('idle');
      const [rel, setRel] = React.useState(''); // relative path of the generated file
      const sessionId = props && props.sessionId;
      const messageId = props && props.messageId;
      const onClick = async () => {
        if (state === 'busy') return;
        if (state === 'done') {
          // Re-click after success: open the generated file in a new tab.
          if (rel) window.open('/handoff/read?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(rel));
          return;
        }
        setState('busy');
        setRel('');
        try {
          const res = await fetch('/handoff/write', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, messageId }),
          });
          const data = await res.json();
          if (data && data.ok === true) {
            setRel(String(data.rel || ''));
            setState('done');
            // Auto-reset to the initial state after ~2s.
            ctx.timeout(() => setState('idle'), 2000);
          } else {
            setState('error');
            setRel(String((data && data.error) || '生成失败'));
          }
        } catch (err) {
          setState('error');
          setRel(String((err && err.message) || '生成失败'));
        }
      };
      let icon;
      if (state === 'done') icon = React.createElement(IconCheckOutline16);
      else if (state === 'error') icon = React.createElement(IconWarningOutline16);
      else icon = React.createElement(IconHistory);
      let tip = '生成 handoff 文档到工作区 /handoff';
      if (state === 'done') tip = '已生成：' + rel + '（点击重新打开）';
      else if (state === 'error') tip = rel;
      const label = state === 'done' ? '打开生成的 handoff 文档' : '生成 handoff 文档';
      return React.createElement(Tooltip, { label: tip, side: 'bottom' },
        React.createElement('button', {
          type: 'button',
          className: 'dsh-handoff-btn',
          'data-state': state,
          'aria-label': label,
          onClick,
          disabled: state === 'busy',
        }, icon),
      );
    }

    const inject = ['slots', 'timer'];

    function apply(ctx) {
      injectStyle();
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
        {
          name: 'conversation.chat.assistant-actions',
          id: 'handoff',
          order: 100,
          label: 'Handoff',
        },
        (props) => HandoffButton(props, ctx),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
