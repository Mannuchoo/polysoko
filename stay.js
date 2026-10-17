let STAYS = [];
function fmtKSh(n) { return 'KSh ' + Number(n || 0).toLocaleString('en-KE'); }
function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
function stayImg(s) { return (s.images && s.images[0]) || './logo-mark.png'; }
function nightsBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function closeStayModal() { document.getElementById('stayModal').classList.remove('open'); }
function filteredStays() {
  var q = (document.getElementById('staySearch').value || '').toLowerCase().trim();
  var g = Number(document.getElementById('stayGuests').value || 0);
  var sort = document.getElementById('staySort').value;
  var list = STAYS.filter(function (s) {
    var hay = ((s.title || '') + ' ' + (s.location || '')).toLowerCase();
    return (!q || hay.indexOf(q) >= 0) && (!g || Number(s.max_guests || 0) >= g);
  });
  if (sort === 'low') list = list.slice().sort(function (a, b) { return a.price_per_night - b.price_per_night; });
  if (sort === 'high') list = list.slice().sort(function (a, b) { return b.price_per_night - a.price_per_night; });
  return list;
}
function renderStays() {
  var grid = document.getElementById('stayGrid');
  var list = filteredStays();
  if (!list.length) { grid.innerHTML = '<p style="color:#8b98a5;">No stays match your search yet.</p>'; return; }
  grid.innerHTML = list.map(function (s) {
    return '<article class="stay-card"><img src="' + escH(stayImg(s)) + '" alt="" loading="lazy" />' +
      '<div class="stay-body"><div style="font-weight:800;">' + escH(s.title) + '</div>' +
      '<div style="color:#8b98a5;font-size:.85rem;">' + escH(s.location) + ' · ' + escH(s.max_guests) + ' guests</div>' +
      '<div style="margin-top:6px;color:#00ff88;font-weight:900;">' + fmtKSh(s.price_per_night) + ' <span style="color:#8b98a5;font-weight:400;font-size:.8rem;">/ night</span></div>' +
      '<button class="stay-btn" onclick="openStayBooking(' + Number(s.id) + ')">View & Book</button></div></article>';
  }).join('');
}
async function loadStays() {
  try {
    var data = await window.apiFetch('stays');
    STAYS = data.stays || data.properties || [];
    renderStays();
  } catch (e) {
    document.getElementById('stayGrid').innerHTML = '<p style="color:#ff8080;">Could not load stays.</p>';
  }
}
async function openStayBooking(id) {
  var s = null;
  for (var i = 0; i < STAYS.length; i++) { if (Number(STAYS[i].id) === Number(id)) s = STAYS[i]; }
  if (!s) return;
  var today = new Date().toISOString().slice(0, 10);
  document.getElementById('stayModalTitle').textContent = s.title;
  var am = (s.amenities || []).map(function (a) { return '<span class="pillx">' + escH(a) + '</span>'; }).join('');
  document.getElementById('stayModalBody').innerHTML =
    '<img src="' + escH(stayImg(s)) + '" style="width:100%;height:200px;object-fit:cover;border-radius:12px;" />' +
    '<p style="color:#9fb0c0;font-size:.9rem;">' + escH(s.description || '') + '</p><div class="pillrow">' + am + '</div>' +
    '<div class="stay-row" style="margin-top:12px;"><label style="font-size:.8rem;color:#8b98a5;">Check-in<input type="date" id="bkIn" min="' + today + '" value="' + today + '" /></label>' +
    '<label style="font-size:.8rem;color:#8b98a5;">Check-out<input type="date" id="bkOut" value="' + today + '" /></label></div>' +
    '<div id="bkTotal" style="margin-top:10px;color:#00ff88;font-weight:800;"></div>' +
    '<input id="bkName" placeholder="Full Name" /><input id="bkEmail" placeholder="Email" type="email" />' +
    '<input id="bkPhone" placeholder="Phone Number (M-Pesa enabled)" type="tel" />' +
    '<button class="stay-btn" onclick="submitStayBooking(' + Number(s.id) + ')">Confirm Booking</button>' +
    '<div id="bkMsg" style="margin-top:10px;font-size:.9rem;"></div>';
  document.getElementById('stayModal').classList.add('open');
  var upd = function () {
    var ci = document.getElementById('bkIn').value;
    var co = document.getElementById('bkOut').value;
    var n = ci && co ? nightsBetween(ci, co) : 0;
    document.getElementById('bkTotal').textContent = n > 0 ? (n + ' night(s) = ' + fmtKSh(n * Number(s.price_per_night))) : 'Select valid dates to see total';
  };
  document.getElementById('bkIn').addEventListener('change', upd);
  document.getElementById('bkOut').addEventListener('change', upd);
  upd();
}
async function submitStayBooking(id) {
  var msg = document.getElementById('bkMsg');
  msg.style.color = '#8b98a5'; msg.textContent = 'Confirming...';
  try {
    var r = await window.apiFetch('stays/book', { method: 'POST', body: {
      property_id: id,
      guest_name: document.getElementById('bkName').value.trim(),
      guest_email: document.getElementById('bkEmail').value.trim(),
      guest_phone: document.getElementById('bkPhone').value.trim(),
      check_in: document.getElementById('bkIn').value,
      check_out: document.getElementById('bkOut').value } });
    if (!r.success) throw new Error(r.message || 'Booking failed');
    document.getElementById('stayModalBody').innerHTML = '<div style="text-align:center;padding:12px 4px;"><div style="font-size:3rem;">🎉</div>' +
      '<h3 style="color:#00ff88;">Booking Confirmed</h3><p>Reference</p>' +
      '<div style="font-size:1.6rem;font-weight:900;">' + escH(r.reference) + '</div>' +
      '<p style="color:#8b98a5;">Total: ' + fmtKSh(r.total_price) + '</p>' +
      '<button class="stay-btn" onclick="closeStayModal()">Done</button></div>';
  } catch (e) { msg.style.color = '#ff8080'; msg.textContent = e.message || 'Booking failed'; }
}
document.getElementById('staySearch').addEventListener('input', renderStays);
document.getElementById('stayGuests').addEventListener('change', renderStays);
document.getElementById('staySort').addEventListener('change', renderStays);
document.getElementById('stayModal').addEventListener('click', function (e) { if (e.target.id === 'stayModal') closeStayModal(); });
loadStays();
