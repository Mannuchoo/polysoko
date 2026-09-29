# Create public directory
New-Item -ItemType Directory -Path public -Force | Out-Null

# Move tracked static frontend files using git mv (preserves history)
$trackedFiles = @(
  'index.html', '404.html', 'admin.html', 'login.html', 'profile.html',
  'history.html', 'news-detail.html', 'reset.password.html', 'sidebar.html',
  'api.js', 'app.js', 'ui.js', 'pwa.js', 'sw.js', 'style.css',
  'favicon.ico', 'favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'logo-mark.png', 'logo 2.jpg', 'site.webmanifest', 'CNAME', '.nojekyll', 'persona.txt'
)
foreach ($f in $trackedFiles) {
  if (Test-Path $f) {
    git mv $f "public/$f"
  }
}

# Move uploads directory into public/
if (Test-Path uploads) {
  Move-Item uploads public/uploads
}

Write-Host 'Static frontend files moved to public/'