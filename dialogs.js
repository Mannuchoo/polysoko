(function () {
    const pending = [];
    let current = false;
    let sequence = 0;

    function ensureStyles() {
        if (document.getElementById('polysoko-dialog-styles')) return;
        const style = document.createElement('style');
        style.id = 'polysoko-dialog-styles';
        style.textContent = `
            .ps-dialog-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(2,6,10,.82);backdrop-filter:blur(7px);}
            .ps-dialog{box-sizing:border-box;width:min(100%,440px);max-height:min(88vh,720px);overflow:auto;padding:24px;background:#111820;color:#eef5f8;border:1px solid #2d3d49;border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.55);font:inherit;}
            .ps-dialog h2{margin:0 32px 10px 0;color:#00e782;font-size:1.15rem;line-height:1.3;}
            .ps-dialog p{margin:0 0 20px;color:#c0cbd2;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;}
            .ps-dialog input,.ps-dialog textarea{box-sizing:border-box;width:100%;margin:0 0 20px;padding:12px 14px;background:#070b10;border:1px solid #344653;border-radius:10px;color:#fff;font:inherit;outline:none;}
            .ps-dialog textarea{min-height:110px;resize:vertical;}
            .ps-dialog input:focus,.ps-dialog textarea:focus{border-color:#00d77a;box-shadow:0 0 0 3px rgba(0,215,122,.14);}
            .ps-dialog-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;}
            .ps-dialog-actions button{min-width:100px;padding:11px 16px;border:1px solid #344653;border-radius:10px;background:#202a33;color:#e8eef2;font:inherit;font-weight:700;cursor:pointer;}
            .ps-dialog-actions button.ps-dialog-primary{border-color:#00d77a;background:linear-gradient(135deg,#00e782,#00bd68);color:#04120a;}
            .ps-dialog-actions button.ps-dialog-danger{border-color:#7d3036;background:#521a20;color:#fff;}
            @media(max-width:480px){.ps-dialog-backdrop{padding:14px;align-items:flex-end}.ps-dialog{width:100%;padding:20px;border-radius:18px 18px 12px 12px}.ps-dialog-actions button{flex:1;}}
        `;
        document.head.appendChild(style);
    }

    function showNext() {
        if (current || !pending.length) return;
        current = true;
        const job = pending.shift();
        const restoreFocus = document.activeElement;
        const id = `ps-dialog-${++sequence}`;
        ensureStyles();

        const backdrop = document.createElement('div');
        backdrop.className = 'ps-dialog-backdrop';
        backdrop.setAttribute('data-ps-dialog', id);
        const dialog = document.createElement('section');
        dialog.className = 'ps-dialog';
        dialog.setAttribute('role', job.kind === 'alert' ? 'alertdialog' : 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', `${id}-title`);
        const title = document.createElement('h2');
        title.id = `${id}-title`;
        title.textContent = job.title || (job.kind === 'confirm' ? 'Please confirm' : 'PolySoko');
        const message = document.createElement('p');
        message.textContent = String(job.message ?? '');
        dialog.append(title, message);

        let field = null;
        if (job.kind === 'prompt') {
            field = job.multiline ? document.createElement('textarea') : document.createElement('input');
            if (!job.multiline) field.type = job.inputType || 'text';
            field.value = job.value ?? '';
            if (job.placeholder) field.placeholder = job.placeholder;
            field.setAttribute('aria-label', job.label || job.message || 'Enter a value');
            dialog.appendChild(field);
        }

        const actions = document.createElement('div');
        actions.className = 'ps-dialog-actions';
        const finish = (value) => {
            document.removeEventListener('keydown', onKeyDown, true);
            backdrop.remove();
            document.body.style.removeProperty('overflow');
            if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus({ preventScroll: true });
            job.resolve(value);
            current = false;
            queueMicrotask(showNext);
        };
        const button = (label, className, value) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = className;
            el.textContent = label;
            el.addEventListener('click', () => finish(typeof value === 'function' ? value() : value));
            actions.appendChild(el);
            return el;
        };
        if (job.kind === 'confirm' || job.kind === 'prompt') button('Cancel', '', job.kind === 'prompt' ? null : false);
        const primary = job.kind === 'confirm'
            ? button(job.confirmLabel || 'Continue', job.danger ? 'ps-dialog-danger' : 'ps-dialog-primary', true)
            : job.kind === 'prompt'
                ? button(job.submitLabel || 'Save', 'ps-dialog-primary', () => field.value)
                : button(job.submitLabel || 'OK', 'ps-dialog-primary', undefined);
        dialog.appendChild(actions);
        backdrop.appendChild(dialog);
        backdrop.addEventListener('mousedown', (event) => {
            if (event.target === backdrop && job.kind !== 'alert') finish(job.kind === 'prompt' ? null : false);
        });
        function onKeyDown(event) {
            if (event.key === 'Escape' && job.kind !== 'alert') {
                event.preventDefault();
                finish(job.kind === 'prompt' ? null : false);
            } else if (event.key === 'Enter' && job.kind === 'prompt' && !job.multiline) {
                event.preventDefault();
                finish(field.value);
            } else if (event.key === 'Tab') {
                const focusable = [...dialog.querySelectorAll('button,input,textarea')].filter(el => !el.disabled);
                if (!focusable.length) return;
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        }
        document.addEventListener('keydown', onKeyDown, true);
        document.body.appendChild(backdrop);
        document.body.style.overflow = 'hidden';
        (field || primary).focus();
        if (field && job.select !== false) field.select?.();
    }

    function enqueue(options) {
        return new Promise(resolve => {
            pending.push({ ...options, resolve });
            showNext();
        });
    }

    window.showAppDialog = (message, options = {}) => enqueue({ kind: 'alert', message, ...options });
    window.showAppConfirm = (message, options = {}) => enqueue({ kind: 'confirm', message, ...options });
    window.showAppPrompt = (message, value = '', options = {}) => enqueue({ kind: 'prompt', message, value, ...options });
    window.alert = (message) => { void window.showAppDialog(message); };
})();
