"""Build the website's app page (public/index.html) from the same source as the Claude artifact (app/companion.html).
The artifact is published without a document skeleton; the website needs one, plus the home-screen manifest and icons."""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
body = (root / 'app' / 'companion.html').read_text()
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="theme-color" content="#0d6e6a"><meta name="apple-mobile-web-app-capable" content="yes">'
        '<meta name="apple-mobile-web-app-title" content="Companion">'
        '<link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/icon-192.png">'
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>'
        '</head><body>')
(root / 'public' / 'index.html').write_text(head + body + '</body></html>')
print('built public/index.html')
