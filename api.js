const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
const isLocalFrontend = LOCAL_HOSTS.includes(window.location.hostname);
const isGitHubPages = window.location.hostname.endsWith('.github.io') || window.location.hostname === 'mannuchoo.github.io';
const DEFAULT_GITHUB_PAGES_API_BASE = "https://api.polysoko.online";
const BACKEND_OVERRIDE_KEY = "backend_url_override";
const FRONTEND_ONLY_HOSTS = ["polysoko.online", "www.polysoko.online", "mannuchoo.github.io"];

function normalizeBackendUrl(rawUrl) {
    if (!rawUrl) return "";
    const trimmed = String(rawUrl).trim();
    if (!trimmed) return "";
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return withProtocol.replace(/\/+$/, "");
}

function isFrontendOnlyApiBase(url) {
    try {
        const parsed = new URL(url);
        return FRONTEND_ONLY_HOSTS.includes(parsed.hostname) || parsed.hostname.endsWith(".github.io");
    } catch {
        return false;
    }
}

function safeBackendUrl(rawUrl, persistBadOverride = false) {
    const backend = normalizeBackendUrl(rawUrl);
    if (!backend) return "";
    if (isGitHubPages && isFrontendOnlyApiBase(backend)) {
        if (!persistBadOverride) localStorage.removeItem(BACKEND_OVERRIDE_KEY);
        console.warn("Ignoring frontend URL as API backend:", backend);
        return "";
    }
    return backend;
}

function getBackendFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const backend = safeBackendUrl(params.get("backend") || params.get("api"), true);
    if (!backend) return "";

    localStorage.setItem(BACKEND_OVERRIDE_KEY, backend);
    params.delete("backend");
    params.delete("api");

    const nextQuery = params.toString();
    window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`
    );
    return backend;
}

function getApiBase() {
    const override = getBackendFromQuery() || safeBackendUrl(localStorage.getItem(BACKEND_OVERRIDE_KEY));
    if (override) return override;

    if (isGitHubPages || FRONTEND_ONLY_HOSTS.includes(window.location.hostname)) {
        return DEFAULT_GITHUB_PAGES_API_BASE;
    }
    return window.location.origin;
}

window.API_BASE = getApiBase();
window.setPolySokoBackend = function setPolySokoBackend(rawUrl) {
    const backend = safeBackendUrl(rawUrl, true);
    if (!backend) throw new Error("Enter a valid backend URL.");
    localStorage.setItem(BACKEND_OVERRIDE_KEY, backend);
    window.API_BASE = backend;
    return backend;
};
window.clearPolySokoBackendOverride = function clearPolySokoBackendOverride() {
    localStorage.removeItem(BACKEND_OVERRIDE_KEY);
    window.API_BASE = getApiBase();
    return window.API_BASE;
};

function apiUrl(path) {
    if (!path) return window.API_BASE || window.location.origin;
    if (/^https?:\/\//i.test(path)) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${window.API_BASE || window.location.origin}${normalized}`;
}

window.apiUrl = apiUrl;

function assetUrl(path, fallback = "") {
    const value = path || fallback;
    if (!value) return "";
    if (/^(data:|blob:|https?:\/\/)/i.test(value)) return value;
    return apiUrl(value);
}

window.assetUrl = assetUrl;

function avatarAssetUrl(path, fallback = "logo-mark.png") {
    const value = path || fallback;
    if (!value) return "";
    const badRemote = /^https?:\/\/[^/]*(ngrok|localhost|127\.0\.0\.1)/i.test(value);
    const badDefault = /\/uploads\/avatars\/default\.png$/i.test(value);
    if ((badRemote && !isLocalFrontend) || badDefault) {
        return assetUrl(fallback);
    }
    return assetUrl(value, fallback);
}

window.avatarAssetUrl = avatarAssetUrl;

function getToken() {
    return localStorage.getItem("token");
}

async function apiFetch(endpoint, options = {}) {
    if (isGitHubPages && !window.API_BASE) {
        throw new Error("Backend not configured for GitHub Pages. Please set DEFAULT_GITHUB_PAGES_API_BASE in api.js.");
    }
    const token = localStorage.getItem("token");
    const cleanEndpoint = (endpoint || '').replace(/^\/?(api\/)?/, '');
    const path = `/api/${cleanEndpoint}`;
    
    const url = `${window.API_BASE}${path}`;

    const headers = { ...options.headers };

    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const defaultOptions = {
        method: options.method || 'GET',
        headers,
    };

    if (options.body) {
        if (options.body instanceof FormData) {
            defaultOptions.body = options.body;
        } else {
            defaultOptions.body = typeof options.body === 'string'
                ? options.body
                : JSON.stringify(options.body);
        }
    }

    let res;
    try {
        res = await fetch(url, defaultOptions);
    } catch (err) {
        console.error("❌ Network Error:", err);
        const msg = "Network error. Unable to connect to the server. Please check your internet connection.";
        throw new Error(msg);
    }

    if (res.status === 401) {
        const criticalRoutes = ['profile', 'user/history', 'my-bets'];
        if (criticalRoutes.some(r => (endpoint || '').toLowerCase().includes(r))) {
            localStorage.removeItem("token");
            window.location.href = "login.html";
        }
        throw new Error("Unauthorized access or session expired.");
    }

    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        console.error("❌ Failed to parse JSON. Response body preview:", text.slice(0, 200));
        if (text.toLowerCase().includes("<html")) {
            throw new Error("Server returned HTML instead of JSON. Check your backend URL configuration.");
        }
        throw new Error("Server returned an invalid non-JSON response.");
    }

    if (!res.ok) throw new Error(data.message || data.error || `API Error (${res.status})`);
    return data;
}
async function fetchProfile() {
    const data = await apiFetch('profile'); 
    
    if (data && data.success && data.user) {
        const u = data.user;
        if (document.getElementById("userName")) document.getElementById("userName").innerText = u.name;
        if (document.getElementById("userNameHeader")) document.getElementById("userNameHeader").innerText = u.name || "User";

        const balanceBtn = document.getElementById('headerBalanceBtn');
        if (balanceBtn && (u.role === 'admin' || Number(u.is_upgraded) === 1)) { 
            if (!document.getElementById('dashAdminBtn')) {
                const adminBtn = document.createElement('button');
                adminBtn.id = 'dashAdminBtn';
                adminBtn.className = 'header-icon-btn';
                adminBtn.style = 'background:#00ff88; color:black; border-color:#00ff88;';
                adminBtn.innerHTML = '⚙️';
                adminBtn.onclick = (e) => { 
                    e.stopPropagation();
                    window.openAdminPanel ? window.openAdminPanel() : window.location.href = 'admin.html'; 
                };
                balanceBtn.insertAdjacentElement('afterend', adminBtn);
            }
        }
        if (document.getElementById("userPhoneDisplay")) {
            document.getElementById("userPhoneDisplay").innerHTML = u.phone 
                ? `<span onclick="window.location.href='tel:${u.phone}'" style="cursor:pointer; margin-right:8px;">📞</span> <a href="tel:${u.phone}" style="color:inherit;text-decoration:none;">${u.phone}</a>` 
                : `<span style="margin-right:8px; opacity:0.5;">📞</span> ---`;
        }
        if (document.getElementById("userEmailDisplay")) {
            const emailAction = u.email ? `<a href="mailto:${u.email}" style="color:inherit;text-decoration:none;">${u.email}</a>` : "Add email";
            document.getElementById("userEmailDisplay").innerHTML = `<span onclick="window.showEmailEdit()" style="cursor:pointer; margin-right:8px;">✉️</span> ${emailAction} <span onclick="window.showEmailEdit()" style="cursor:pointer; margin-left:8px; opacity:0.8;">✏️</span>`;
        }
        if (document.getElementById("editName")) document.getElementById("editName").value = u.name || "";
        if (document.getElementById("editEmail")) document.getElementById("editEmail").value = u.email || "";

        const isUpgraded = u.is_upgraded === 1;
        const btnHtml = `
            <button id="upgradeBtn" onclick="window.startUpgradeFlow()" style="width:100%; padding: 18px; border-radius: 12px; border: none; font-weight: 900; cursor: pointer; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 20px; transition: 0.3s; ${isUpgraded ? 'background: rgba(0,255,136,0.1); color: #00ff88; border: 1px solid #00ff88;' : 'background: linear-gradient(90deg, #00ff88, #00ccff); color: black; box-shadow: 0 0 25px rgba(0,255,136,0.5);'}">
                ${isUpgraded ? 'ELITE ACTIVE 💎' : 'UPGRADE ⚡'}
            </button>`;

        if (u.role !== 'admin') {
            const upgradeArea = document.getElementById("upgradeArea");
            if (upgradeArea) {
                upgradeArea.innerHTML = btnHtml;
            } else {
                const actions = document.getElementById('userActionsArea') || document.getElementById('userActions');
                if (actions) {
                    actions.insertAdjacentHTML('afterbegin', btnHtml);
                }
            }
        }

        localStorage.setItem("user_data", JSON.stringify(u));
        if (typeof window.renderBalanceDisplay === 'function') window.renderBalanceDisplay();
        
        const refEl = document.getElementById("referralCodeDisplay");
        if (refEl) {
            refEl.innerText = u.status === 'verified' ? u.referral_code : "Verify email to see code";
        }

        if (u.role === 'admin') {
            const adminArea = document.getElementById("adminActionsArea");
            if (adminArea) {
                adminArea.innerHTML = `
                    <button onclick="location.href='admin.html'" class="pill active" style="width:100%; margin-top:10px; background:#da020e; color:white; font-weight:900; letter-spacing:1px; box-shadow: 0 4px 15px rgba(218, 2, 14, 0.3);">⚙️ ENTER MANAGEMENT CONSOLE</button>
                    <button onclick="window.showUserManagement()" class="pill active" style="width:100%; margin-top:10px; background:#00ff88; color:black; font-weight:bold;">👥 MANAGE USER DIRECTORY</button>
                    <button onclick="window.openMpesaDashboard('withdraw')" class="pill active" style="width:100%; margin-top:10px; background:#3b82f6; color:white; font-weight:bold;">💸 WITHDRAWAL REQUESTS</button>
                    <button onclick="window.openMpesaDashboard('deposit')" class="pill active" style="width:100%; margin-top:10px; background:#00ff88; color:black; font-weight:bold;">💰 DEPOSIT MPESA LOG</button>
                `;
            }
        }

        if (document.getElementById("roleBadge")) document.getElementById("roleBadge").innerText = (u.role || "user").toUpperCase();

        const defaultAvatar = "logo-mark.png";
        const avatarUrl = avatarAssetUrl(u.avatarUrl || u.avatar_url, defaultAvatar);
        const fallbackAvatarUrl = assetUrl(defaultAvatar);
        if (document.getElementById("userAvatar")) {
            document.getElementById("userAvatar").src = avatarUrl;
            document.getElementById("userAvatar").onerror = function() { this.onerror = null; this.src = fallbackAvatarUrl; };
        }
        if (document.getElementById("headerAvatar")) {
            document.getElementById("headerAvatar").src = avatarUrl;
            document.getElementById("headerAvatar").onerror = function() { this.onerror = null; this.src = fallbackAvatarUrl; };
        }
        if (u.avatar_url && !/\/uploads\/avatars\/default\.png$/i.test(u.avatar_url)) {
            localStorage.setItem('saved_avatar_path', u.avatar_url);
            localStorage.setItem('saved_avatar_url', avatarUrl);
        } else {
            localStorage.removeItem('saved_avatar_path');
            localStorage.removeItem('saved_avatar_url');
        }
    }
}
window.fetchProfile = fetchProfile;

function restoreSavedAvatar() {
    const savedPath = localStorage.getItem('saved_avatar_path');
    const savedUrl = localStorage.getItem('saved_avatar_url');
    if (!savedPath && !savedUrl) return;
    const normalized = avatarAssetUrl(savedPath || savedUrl);
    if (document.getElementById("userAvatar")) document.getElementById("userAvatar").src = normalized;
    if (document.getElementById("headerAvatar")) document.getElementById("headerAvatar").src = normalized;
}

window.addEventListener('DOMContentLoaded', () => {
    restoreSavedAvatar();
});


async function login(payload) {
    return apiFetch('login', { method: 'POST', body: payload });
}


async function register(payload) {
    return apiFetch('register', { method: 'POST', body: payload });
}
  

async function resetPassword(token, newPassword, otp) {
    return apiFetch('reset-password', {
        method: 'POST',
        body: { token, newPassword, otp }
    });
}

window.showWelcomeHeader = function() {
    const welcome = document.getElementById('loginWelcome') || document.querySelector('h2');
    if (welcome) {
        welcome.id = 'loginWelcome';
        welcome.innerText = "SOKO NI SOKO. Karibu POLYSOKO!";
        welcome.style.color = "#00ff88";
        welcome.style.textShadow = "0 0 15px rgba(0, 255, 136, 0.6)";
        welcome.style.opacity = "0";
        welcome.style.transition = "opacity 1.5s ease-in, transform 1s ease-out";
        welcome.style.transform = "translateY(-10px)";
        setTimeout(() => {
            welcome.style.opacity = '1';
            welcome.style.transform = "translateY(0)";
        }, 100);
    }
};

async function updateEmail(email) {
    return apiFetch('user/update-email', {
        method: "POST",
        body: { email }
    });
}

async function upgradeAccount() {
    return apiFetch('user/upgrade', {
        method: 'POST',
        body: {}
    });
}

async function adminCreateMarket(payload) {
    const userData = JSON.parse(localStorage.getItem("user_data") || "{}");
    const endpoint = userData.role === 'admin' ? 'admin/create-market' : 'user/submit-market';
    
    return apiFetch(endpoint, {
        method: 'POST',
        body: payload
    });
}

async function depositCrypto(payload) {
    return apiFetch('user/deposit-crypto', {
        method: 'POST',
        body: payload
    });
}

async function deleteNotification(id) {
    return apiFetch(`notifications/${id}`, { method: 'DELETE' });
}

async function markNotificationsRead() {
    return apiFetch('notifications/read-all', { method: 'POST' });
}

async function updateProfile(payload) {
    return apiFetch('user/update', {
        method: 'POST',
        body: payload
    });
}

async function fetchMpesaLog() {
    return apiFetch('admin/mpesa-log');
}


async function fetchTransactions() {
    try {
        const data = await apiFetch('user/history');
        if (!data || !data.success) return [];
        return data.history || [];
    } catch (err) {
        console.error("❌ fetchTransactions sync failed:", err);
        throw err; 
    }
}


window.placeBet = async function(marketId, side, amount) {
    const token = localStorage.getItem("token");
    if (!token) return alert("Login required"), false;

    try {
        const data = await apiFetch('place-bet', {
            method: "POST",
            body: { marketId, side, amount }
        });

        if (data.success) {
            const user = JSON.parse(localStorage.getItem("user_data") || "{}");
            if (user.balance !== undefined) {
                user.balance = Number(user.balance) - amount;
                localStorage.setItem("user_data", JSON.stringify(user));
            }
            if (typeof window.renderBalanceDisplay === 'function') window.renderBalanceDisplay();

            if (typeof window.refreshBets === "function") {
                await window.refreshBets('active'); 
            }

            alert("Bet confirmed!");
            return true;
        } else {
            alert(data.message || "Bet failed");
            return false;
        }

    } catch (err) {
        console.error("❌ error:", err);
        alert("Connection error. Please try again.");
        return false;
    }
};

window.showEmailEdit = function() {
    const display = document.getElementById("userEmailDisplay");
    const currentEmail = JSON.parse(localStorage.getItem("user_data") || "{}").email || "";
    display.innerHTML = `
        <div style="display:flex; align-items:center; gap:5px; background:#111; padding:4px 8px; border-radius:8px; border:1px solid #333;">
            <input type="email" id="inlineEmailInput" value="${currentEmail}" style="background:none; border:none; color:white; font-size:0.85rem; width:140px; outline:none;" autofocus>
            <span onclick="window.saveEmailInline()" style="cursor:pointer; font-size:1.1rem; filter: drop-shadow(0 0 5px #00ff88);">✔️</span>
        </div>
    `;
};

window.saveEmailInline = async function() {
    const email = document.getElementById("inlineEmailInput").value.trim();
    if (!email || !email.includes('@')) return alert("Please enter a valid email");

    try {
        const res = await apiFetch('user/update-email', {
            method: "POST",
            body: { email }
        });

        if (res.success) {
            fetchProfile();
        } else {
            alert(res.message || "Failed to update email");
        }
    } catch (err) { console.error(err); }
};

async function fetchGlobalNews() {
    try {
        const res = await apiFetch("news/everything");
        
        const newsData = res.articles || res || [];
        return newsData;
    } catch (err) {
        console.error("❌ fetchGlobalNews error:", err);
        return [];
    }
}


window.processWithdraw = async function() {
    const amount = prompt("Enter amount to withdraw (min 100 sKES):");
    
    if (!amount || amount.trim() === "") return; 
    const withdrawAmt = parseFloat(amount);
    
    if (isNaN(withdrawAmt) || withdrawAmt < 100) {
        return alert("Minimum withdrawal is 100 sKES");
    }

    try {
        await apiFetch('withdraw', {
            method: 'POST',
            body: { amount: withdrawAmt }
        });

        if (typeof showToast === 'function') {
            showToast("💸 Withdrawal requested successfully! Check your M-Pesa.");
        }
        
        if (typeof fetchProfile === 'function') fetchProfile(); 
        if (typeof loadHistory === 'function') loadHistory();   
        
        if (typeof toggleAccountCenter === 'function') toggleAccountCenter();

    } catch (e) {
        console.error("Withdraw error:", e);
        if (typeof showToast === 'function') {
            const errorMsg = e.message || "Insufficient balance or connection error";
            showToast("❌ Withdraw failed: " + errorMsg, "red");
        }
    }
};
window.toggleWithdrawModal = function() {
    let modal = document.getElementById('withdrawModal');
    
    if (!modal) {
        console.log("Withdraw modal missing. Creating universal instance...");
        const modalHtml = `
            <div id="withdrawModal" class="modal-overlay" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.9); z-index: 100000; justify-content: center; align-items: center; backdrop-filter: blur(5px);">
                <div class="modal-content" style="background: #1a1b22; padding: 25px; border-radius: 16px; border: 1px solid #333; width: 90%; max-width: 350px;">
                    <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <h3 style="color:white; margin:0;">Withdraw Funds</h3>
                        <button onclick="document.getElementById('withdrawModal').style.display='none'" style="background:none; border:none; color:gray; font-size:1.5rem; cursor:pointer;">✕</button>
                    </div>
                    <div class="modal-body">
                        <p style="color: gray; font-size: 0.8rem; margin-bottom:10px;">Minimum withdrawal: 100 sKES</p>
                        <input type="number" id="withdrawAmount" placeholder="Enter amount" style="width: 100%; background: #0b0c10; border: 1px solid #3f3f46; padding: 12px; border-radius: 8px; color: white; margin-bottom:20px;">
                        <button onclick="handleWithdrawSubmit(event)" style="width: 100%; background: #00ff88; color: black; border: none; padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer;">💸 Request Withdrawal</button>
                    </div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        return; 
    }

    const isHidden = window.getComputedStyle(modal).display === 'none';
    modal.style.display = isHidden ? 'flex' : 'none';
};

window.handleWithdrawSubmit = async function(event) {
    const amountInput = document.getElementById('withdrawAmount');
    const amount = parseFloat(amountInput?.value);

    if (!amount || amount < 100) {
        alert("Please enter an amount of at least 100 sKES");
        return;
    }

    const btn = event?.currentTarget || event?.target;
    const originalText = btn?.innerText;
    if (btn) {
        btn.innerText = "Processing...";
        btn.disabled = true;
    }

    try {
        const result = await apiFetch('withdraw', {
            method: 'POST',
            body: { amount: amount }
        });

        if (result.success) {
            alert("💸 Withdrawal request successful!");
            const modal = document.getElementById('withdrawModal');
            if (modal) modal.style.display = 'none';
            if (window.fetchProfile) await window.fetchProfile(); 
            if (window.loadHistory) window.loadHistory();
        } else {
            alert(result.message || "Failed to process withdrawal");
        }
    } catch (err) {
        console.error("Withdrawal Error:", err);
        alert(err.message || "Server error. Please try again later.");
    } finally {
        if (btn) {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }
};
window.triggerDeposit = function() {
    let modal = document.getElementById('depositModal');
    
    if (!modal) {
        console.log("Deposit modal missing. Creating universal instance...");
        const modalHtml = `
            <div id="depositModal" class="modal-overlay" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.9); z-index: 100001; justify-content: center; align-items: center; backdrop-filter: blur(5px);">
                <div class="modal-content" style="background: #1a1b22; padding: 25px; border-radius: 16px; border: 1px solid #333; width: 90%; max-width: 380px; position: relative;">
                    <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <h3 style="color:white; margin:0;">Deposit Funds</h3>
                        <button onclick="document.getElementById('depositModal').style.display='none'" style="background:none; border:none; color:gray; font-size:1.5rem; cursor:pointer;">✕</button>
                    </div>
                    <div class="modal-body" style="text-align: center;">
                        <p style="color: #00ff88; font-size: 0.85rem; margin-bottom:15px; font-weight:bold;">Instant M-PESA Deposit</p>
                        
                        <div style="text-align: left; margin-bottom: 20px;">
                            <label style="color: #888; font-size: 0.75rem; display: block; margin-bottom: 5px;">AMOUNT (sKES)</label>
                            <input type="number" id="depositAmount" placeholder="Min 1 KES" style="width: 100%; background: #000; border: 1px solid #444; padding: 15px; border-radius: 8px; color: white; font-size: 1.2rem; font-weight: bold;">
                        </div>

                                        <button onclick="handleDepositSubmit(event)" style="width: 100%; background: #00ff88; color: black; border: none; padding: 15px; border-radius: 10px; font-weight: bold; cursor: pointer; font-size: 1rem;">
                            💰 Deposit Now
                        </button>
                        <button onclick="openCryptoDeposit()" style="width: 100%; margin-top:10px; background: #111; color: #00ff88; border: 1px solid #00ff88; padding: 12px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 0.95rem;">
                            Deposit from Crypto
                        </button>
                        
                        <p style="color: #555; font-size: 0.7rem; margin-top: 15px;">
                            By clicking Deposit, you will receive an STK Push on your registered M-PESA number.
                        </p>
                    </div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        return;
    }

    modal.style.display = 'flex';
};
window.handleDepositSubmit = async function(event) {
    const amountInput = document.getElementById('depositAmount');
    const amount = parseFloat(amountInput?.value);

    if (!amount || amount < 1) {
        alert("Minimum deposit is 1 sKES");
        return;
    }

    const btn = event?.currentTarget || event?.target;
    const originalText = btn?.innerText;
    if (btn) {
        btn.innerText = "Processing...";
        btn.disabled = true;
    }

    try {
        const result = await apiFetch('stkpush', {
            method: 'POST',
            body: { amount: amount }
        });

        if (result.success) {
            alert("STK Push sent! Check your phone to enter your M-PESA PIN.");
            document.getElementById('depositModal').style.display = 'none';
            if (window.fetchProfile) await window.fetchProfile();
            if (window.loadHistory) window.loadHistory();
        } else {
            alert(result.message || "Deposit request failed");
        }
    } catch (err) {
        console.error("Deposit Error:", err);
        alert(err.message || "Connection error. Please try again.");
    } finally {
        if (btn) {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }
};
async function refreshBalance() {
    const data = await apiFetch('user/sync-wallet');
    if (data.success) {
        document.getElementById('userBalance').innerText = data.balance;
        alert("Balance synced with Blockchain!");
    }
}
window.API = {
    login,
    register,
    fetchProfile,
    fetchTransactions,
    updateEmail,
    upgradeAccount,
    updateProfile,
    placeBet: window.placeBet,
    fetchMpesaLog,
    fetchGlobalNews,
    triggerDeposit: window.triggerDeposit,
    processWithdraw: window.processWithdraw,
    refreshBalance,
    resetPassword,
    adminCreateMarket,
    depositCrypto,
    deleteNotification,
    markNotificationsRead
};
window.API.apiFetch = apiFetch;
window.apiFetch = apiFetch;