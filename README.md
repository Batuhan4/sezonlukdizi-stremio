# SezonlukDizi Stremio Addon

SezonlukDizi (sezonlukdizi.cc) üzerindeki yabancı dizileri Stremio'da, Türkçe **altyazı** ve **dublaj** seçenekleriyle izlemenizi sağlayan bir addon.

> **Not:** Bu proje, kardeş addon [hdfilmcehennemi-stremio](https://github.com/batuhan4/hdfilmcehennemi-stremio) mimarisi temel alınarak sezonlukdizi.cc için sıfırdan uyarlanmıştır (fork-style build). Stremio SDK iskeleti, m3u8 proxy tasarımı, logger/errors/proxy katmanları ortaktır; arama, bölüm çözümleme ve video çıkarma mantığı bu siteye özgüdür.

## Özellikler

- 📺 Dizi desteği (sadece `series` — film kapsam dışı)
- 🔤 Türkçe altyazılı (Altyazı) ve dublajlı (Dublaj) kaynaklar ayrı stream olarak
- 🔗 IMDb ID → dizi eşleştirmesi tek istekte (site aramasi tt-id kabul ediyor)
- 🧩 Çoklu embed host desteği: **VidMoly, Filemoon, Sibnet, VideoSoft, Okru, Streamruby** (bir bölümde birden çok kaynak varsa hepsi ayrı stream olarak listelenir)
- 📡 TV uyumluluğu için sunucu-taraflı m3u8 proxy (`/proxy/m3u8`)

## Nasıl çalışır

```
IMDb id ──POST /ajax/arama.asp q=<ttid>──▶ dizi sayfası + slug
   slug + sezon/bölüm ──▶ /<slug>/<S>-sezon-<E>-bolum.html  (deterministik)
   bölüm sayfası ──▶ bolum id (#dilsec[data-id])
        ├─ POST /ajax/dataAlternatif22.asp  bid&dil=1|0 ──▶ kaynak listesi
        └─ POST /ajax/dataEmbed22.asp       id          ──▶ <iframe src>
   embed host (VidMoly ...) ──▶ .m3u8  +  gereken Referer/Origin
```

- **IMDb eşleştirme:** Arama endpoint'i (`/ajax/arama.asp`) doğrudan tt-id kabul ettiği için Cinemeta'ya gerek yok. Boş dönerse: Cinemeta başlık → başlıkla arama → dizi sayfasındaki `imdb.com/title/tt...` bağlantısıyla doğrulama.
- **Karakter kodlaması:** Site (HTML **ve** AJAX JSON) `windows-1254` kullanıyor. `httpClient.js` her gövdeyi ham bayt olarak okuyup `TextDecoder('windows-1254')` ile çözüyor — aksi halde Türkçe karakterler bozulur ve arama çalışmaz.
- **Cloudflare:** Addon'un kullandığı hiçbir endpoint JA3/challenge kapısı arkasında değil (yalnızca `/diziler.asp?adi=` challenge veriyor, o da hiç kullanılmıyor). Bu yüzden `curl` fallback'ine gerek yok.

## Desteklenen embed host'lar

Bir bölüm için `dataAlternatif22.asp` birden çok host döndürebilir; yalnızca çözümleyicisi (`HOST_RESOLVERS`) olan host'lar denenir ve bulunanların hepsi ayrı stream olarak (host + Altyazılı/Dublaj etiketiyle) listelenir.

| Host | Kaynak türü | Durum |
|------|-------------|-------|
| **VidMoly** | HLS (m3u8) | ✅ Çalışıyor |
| **Filemoon** (Byse frontend) | HLS (m3u8) | ✅ Çalışıyor — API `AES-256-GCM` şifreli blob'u sunucu tarafında çözülür |
| **Sibnet** | MP4 (progressive) | ✅ Çalışıyor — Referer-korumalı 302 zinciri gövde indirilmeden takip edilir |
| **VideoSoft** (videoseyred.in) | HLS (m3u8) | ✅ Çalışıyor — `playlist/N.json` |
| **Okru** (ok.ru) | HLS (m3u8) | ✅ Çalışıyor — tam Chrome UA gerekir (okcdn imzası) |
| **Streamruby** (rubyvidhub) | HLS (m3u8) | ✅ Çalışıyor — P.A.C.K.E.R unpack; medya IP-locked (resolve+proxy aynı egress) |
| **ABStream** (abstream.to) | HLS (m3u8) | ⚠️ Çözümleyici eklendi ama sitede canlı kaynak bulunamadı; uçtan uca test edilmedi |
| **Netu / hqq.to** | — | ❌ Sunucu tarafında güvenilir çözülemedi |
| **Pixel** | — | ❌ Cloudflare Turnstile captcha ile korunuyor |

**Notlar:**
- Medya token'ları kısa ömürlüdür (Filemoon ~3s, ABStream ~2s, Filemoon/Streamruby birkaç saat, Okru ~24s); addon her istekte anlık çözdüğü için sorun olmaz — çözülen m3u8 uzun süre önbelleğe alınmaz.
- Bazı host'lar (Streamruby IP-lock; Okru/VideoSoft imzalı segmentler) medyanın, çözümü yapan sunucuyla **aynı egress IP**'sinden proxy'lenmesine dayanır — addon zaten segmentleri `/proxy/stream` üzerinden aynı çıkıştan sunar.

## Kurulum

### Gereksinimler

- Node.js 18+ (windows-1254 için full-ICU derlemesi — resmi Node ikilileri bunu içerir)
- npm

```bash
git clone <repo>
cd sezonlukdizi-stremio
npm install
npm start
```

Addon varsayılan olarak `http://localhost:7000/manifest.json` adresinde çalışır.

## Yapılandırma

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `PORT` | 7000 | Sunucu portu |
| `BASE_URL` | http://localhost:7000 | Addon'un public URL'i (TV oynatımı için m3u8 proxy'de kullanılır) |
| `LOG_LEVEL` | info | Log seviyesi (debug, info, warn, error) |
| `SITE_DOMAIN` | sezonlukdizi.cc | Ana site alan adı (domain değişince tek satır ayar) |
| `PROXY_ENABLED` | never | Proxy modu: `never` (Türkiye'den doğrudan), `auto`/`always` (yurt dışı) |

> Stremio yalnızca HTTPS manifest kabul eder; uzak kurulumda bir domain + reverse proxy (veya Cloudflare Tunnel) gerekir. Türkiye içi LAN kullanımında `PROXY_ENABLED=never` yeterlidir.

## Test

```bash
npm test
# veya farklı bir hedef:
TEST_IMDB=tt0460681 TEST_SEASON=1 TEST_EPISODE=1 npm test
```

Test, canlı siteye seri (rate-limited) istek atarak arama → bölüm çözümleme → video çıkarma zincirini uçtan uca doğrular. Örnek hedef: **Supernatural (2005)** `tt0460681` S1E1.

## Proje Yapısı

```
├── addon.js       # Stremio addon sunucusu + m3u8/stream proxy
├── config.js      # Site alan adı / proxy yapılandırması
├── httpClient.js  # windows-1254 çözen, serileştirilmiş HTTP istemcisi (GET/POST)
├── search.js      # IMDb → dizi slug → bölüm URL çözümleme
├── scraper.js     # bolum id → AJAX kaynakları → embed host → m3u8 çıkarma
├── proxy.js       # Türkiye proxy listesi yönetimi (varsayılan kapalı)
├── logger.js      # Log sistemi
├── errors.js      # Hata sınıfları
├── test.js        # Uçtan uca canlı test
└── package.json
```

## Yeni embed host eklemek

`scraper.js` içindeki `HOST_RESOLVERS` sözlüğüne, `dataAlternatif22.asp`'nin döndürdüğü `baslik` (küçük harf) anahtarıyla bir çözümleyici ekleyin. Her çözümleyici embed iframe'ini alıp `{videoUrl, referer, origin}` döndürür. Ortak yardımcılar hazır: base64url çözme, HTML unescape, P.A.C.K.E.R (`eval(function(p,a,c,k,e,d))`) unpack ve gövdesiz redirect takibi. Mevcut host'lar için yukarıdaki [tabloya](#desteklenen-embed-hostlar) bakın; henüz çözülemeyenler Netu ve Pixel'dir.

## Lisans

MIT License — bkz. [LICENSE](LICENSE).

## ⚠️ Sorumluluk Reddi

Bu addon yalnızca eğitim amaçlıdır. İçeriklerin telif hakları sahiplerine aittir; addon içerik barındırmaz, yalnızca herkese açık kaynaklara bağlantı çözümler.
