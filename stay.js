let STAYS = [];
function fmtKSh(n) { return 'KSh ' + Number(n || 0).toLocaleString('en-KE'); }
function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
function stayImgs(s) {
  var arr = Array.isArray(s.images) ? s.images.slice(0, 15) : [];
  return arr.length ? arr : ['./logo-mark.png'];
}
function stayImg(s) { return stayImgs(s)[0]; }
function nightsBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function closeStayModal() { document.getElementById('stayModal').classList.remove('open'); }
function openSrLightbox(src) {
  var lb = document.getElementById('srLightbox');
  document.getElementById('srLightImg').src = src;
  lb.classList.add('open');
}
function closeSrLightbox() { document.getElementById('srLightbox').classList.remove('open'); }
function srCarouselHTML(imgs, cid) {
  var slides = imgs.map(function (src, i) {
    return '<div class="sr-slide"><img src="' + escH(src) + '" alt="Photo ' + (i + 1) + '" loading="lazy" onclick="openSrLightbox(\'' + escH(src).replace(/'/g, '%27') + '\')" style="cursor:zoom-in;" /></div>';
  }).join('');
  var dots = imgs.map(function (_, i) {
    return '<button class="sr-dot' + (i === 0 ? ' on' : '') + '" data-i="' + i + '" onclick="srGo(\'' + cid + '\',' + i + ')" aria-label="Photo ' + (i + 1) + '"></button>';
  }).join('');
  return '<div class="sr-carousel" id="' + cid + '"><div class="sr-track" onscroll="srSyncDots(\'' + cid + '\')">' + slides + '</div>' +
    (imgs.length > 1 ? '<button class="sr-arrow sr-prev" onclick="srStep(\'' + cid + '\',-1)">‹</button><button class="sr-arrow sr-next" onclick="srStep(\'' + cid + '\',1)">›</button>' : '') +
    '<span class="sr-count">1 / ' + imgs.length + '</span></div>' +
    (imgs.length > 1 ? '<div class="sr-dots">' + dots + '</div>' : '');
}
function srTrack(cid) { var el = document.getElementById(cid); return el ? el.querySelector('.sr-track') : null; }
function srStep(cid, dir) { var t = srTrack(cid); if (t) t.scrollBy({ left: dir * t.clientWidth, behavior: 'smooth' }); }
function srGo(cid, i) { var t = srTrack(cid); if (t) t.scrollTo({ left: i * t.clientWidth, behavior: 'smooth' }); }
function srSyncDots(cid) {
  var box = document.getElementById(cid); if (!box) return;
  var t = box.querySelector('.sr-track'); if (!t) return;
  var i = Math.round(t.scrollLeft / Math.max(1, t.clientWidth));
  var dots = box.parentElement ? box.parentElement.querySelectorAll('.sr-dot') : [];
  var own = box.querySelectorAll ? [] : [];
  var all = (box.parentNode || document).querySelectorAll('#' + cid + ' ~ .sr-dots .sr-dot');
  for (var k = 0; k < all.length; k++) { if (k === i) all[k].classList.add('on'); else all[k].classList.remove('on'); }
  var c = box.querySelector('.sr-count');
  if (c) c.textContent = (Math.min(i + 1, 99)) + ' / ' + (box.querySelectorAll('.sr-slide').length);
}
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
    srCarouselHTML(stayImgs(s), 'srModal') +
    '<p style="color:#9fb0c0;font-size:.9rem;">' + escH(s.description || '') + '</p><div class="pillrow">' + am + '</div>' +
    '<div class="stay-row" style="margin-top:12px;"><label style="font-size:.8rem;color:#8b98a5;">Check-in<input type="date" id="bkIn" min="' + today + '" value="' + today + '" /></label>' +
    '<label style="font-size:.8rem;color:#8b98a5;">Check-out<input type="date" id="bkOut" value="' + today + '" /></label></div>' +
    '<div id="bkAvail"></div>' +
    '<div id="bkTotal" style="margin-top:10px;color:#00ff88;font-weight:800;"></div>' +
    '<input id="bkName" placeholder="Full Name" /><input id="bkEmail" placeholder="Email" type="email" />' +
    '<input id="bkPhone" placeholder="Phone Number (M-Pesa enabled)" type="tel" />' +
    '<button class="stay-btn" id="bkConfirmBtn" onclick="submitStayBooking(' + Number(s.id) + ')">Confirm Booking</button>' +
    '<div style="margin-top:12px;border-top:1px solid #223041;padding-top:10px;">' +
    '<div style="font-size:.8rem;color:#8b98a5;">Already have a PAID reference? Unlock the exact location:</div>' +
    '<div style="display:flex;gap:8px;margin-top:6px;"><input id="bkLookup" placeholder="STAY-XXXXXX" style="margin-top:0;" /><button class="stay-btn" style="width:auto;margin-top:0;white-space:nowrap;" onclick="lookupPaidBooking()">View</button></div>' +
    '<div id="bkLookupOut" style="margin-top:8px;font-size:.85rem;"></div></div>' +
    '<div id="bkMsg" style="margin-top:10px;font-size:.9rem;"></div>';
  document.getElementById('stayModal').classList.add('open');
  var timer = null;
  var upd = function () {
    var ci = document.getElementById('bkIn').value;
    var co = document.getElementById('bkOut').value;
    var n = ci && co ? nightsBetween(ci, co) : 0;
    document.getElementById('bkTotal').textContent = n > 0 ? (n + ' night(s) = ' + fmtKSh(n * Number(s.price_per_night))) : 'Select valid dates to see total';
    var box = document.getElementById('bkAvail');
    var btn = document.getElementById('bkConfirmBtn');
    if (!(n > 0)) { box.innerHTML = ''; if (btn) btn.disabled = false; return; }
    box.innerHTML = '<span style="color:#8b98a5;font-size:.8rem;">Checking availability…</span>';
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { checkStayAvailability(Number(s.id), ci, co); }, 450);
  };
  document.getElementById('bkIn').addEventListener('change', upd);
  document.getElementById('bkOut').addEventListener('change', upd);
  upd();
}
async function checkStayAvailability(id, ci, co) {
  var box = document.getElementById('bkAvail');
  var btn = document.getElementById('bkConfirmBtn');
  try {
    var r = await window.apiFetch('stays/' + id + '/availability?check_in=' + encodeURIComponent(ci) + '&check_out=' + encodeURIComponent(co));
    if (r.available === false || r.status === 'BOOKED') {
      box.innerHTML = '<span class="sr-booked">Already Booked for Selected Dates</span><div style="color:#ff8080;font-size:.8rem;margin-top:6px;">' + escH(r.message || 'This unit is already booked for the selected dates.') + '</div>';
      if (btn) btn.disabled = true;
    } else {
      box.innerHTML = '<span class="sr-avail">Available for Selected Dates</span>';
      if (btn) btn.disabled = false;
    }
  } catch (e) { box.innerHTML = ''; if (btn) btn.disabled = false; }
}
async function lookupPaidBooking() {
  var out = document.getElementById('bkLookupOut');
  var ref = (document.getElementById('bkLookup').value || '').trim();
  if (!ref) { out.textContent = 'Enter your STAY-XXXXXX reference.'; return; }
  out.style.color = '#8b98a5'; out.textContent = 'Looking up…';
  try {
    var r = await window.apiFetch('stays/booking/' + encodeURIComponent(ref));
    if (!r.success) throw new Error(r.message || 'Not found');
    var p = r.property || {};
    out.innerHTML = '<b>Exact address:</b> ' + escH(p.exact_address || p.location || '') +
      (p.google_maps_link ? '<br><a href="' + escH(p.google_maps_link) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : '') +
      ((p.latitude != null && p.longitude != null) ? '<br><span style="color:#8b98a5;">' + escH(p.latitude) + ', ' + escH(p.longitude) + '</span>' : '');
  } catch (e) { out.style.color = '#ff8080'; out.textContent = e.message || 'Location unlocks after payment is confirmed.'; }
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
