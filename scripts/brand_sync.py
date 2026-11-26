#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
BRAND STUDIO — 1 nguon -> dong bo toan dien (logo, icon, favicon, mipmap, splash,
button/mau glass) cho CA SigMa (web-demo/landing/PC/APK) lan Quan Ly SigMa (desktop).

DOI BRAND:
  1) Thay  assets/brand/<icon master>  (PNG vuong bat ky — script tu bo goc tron).
  2) Sua   assets/brand/brand.tokens.json  (palette lay tu mau logo moi).
  3) Chay  `npm run brand:sync`            (them `--android` de sinh mipmap/splash APK).
  4) Rebuild app.

NGUYEN TAC (khoa cung):
  - Moi raster = RESIZE LANCZOS tu 1 rounded-master, GIU alpha. Khong compose nen trang,
    khong bo goc lai tung file, khong tach nen tung file. => khong the lech thiet ke.
  - Thay the generator cu build/gen-brand-assets.mjs (compose nen trang) — dung script nay.
"""
import sys, json, io, struct, subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "assets" / "brand"
TOK = json.loads((BRAND / "brand.tokens.json").read_text(encoding="utf-8"))
ANDROID = "--android" in sys.argv
CHECK = "--check" in sys.argv

def log(*a): print("[brand]", *a)
def rgb(h): h=h.lstrip("#"); return tuple(int(h[i:i+2],16) for i in (0,2,4))

# ---------- 1) ROUNDED MASTER (tu file vuong bat ky) ----------
def load_rounded_master():
    src = BRAND / TOK["icon"]["master"]
    if not src.exists():
        # fallback: dung ban master da bo goc san
        src = BRAND / "alpha-icon-master.png"
    im = Image.open(src).convert("RGBA"); W,H = im.size
    # NHANH 1: nguon DA TACH NEN (goc trong suot) -> dung nguyen, chi crop sat noi dung.
    corners_a = [im.getpixel(p)[3] for p in [(1,1),(W-2,1),(1,H-2),(W-2,H-2)]]
    if max(corners_a) < 20:
        return im.crop(im.getbbox())
    # NHANH 2: nguon nen TRANG -> matte PIXEL-PERFECT: silhouette (flood-fill) ∩ rounded-rect(tile) ∪ vung bao hoa.
    #   -> loai bong do (low-sat ngoai tile), bo goc day sach, khong vien trang, khong lem chu A nho.
    radius_pct = float(TOK["icon"]["cornerRadiusPct"])
    rgbim = im.convert("RGB"); work = rgbim.copy(); SENT=(255,0,255)
    for s in [(1,1),(W-2,1),(1,H-2),(W-2,H-2),(W//2,1),(W//2,H-2),(1,H//2),(W-2,H//2)]:
        ImageDraw.floodfill(work, s, SENT, thresh=44)
    sil = ~np.all(np.array(work)==np.array(SENT), axis=-1)
    ys,xs = np.where(sil); l,t,r = int(xs.min()),int(ys.min()),int(xs.max())
    side = r-l; tile_bottom = t+side                       # tile la hinh vuong -> bo bong o duoi
    arr = np.array(rgbim).astype(int); satm = (arr.max(2)-arr.min(2)) > 45
    SS=4; rw=(r-l+1)*SS; rh=(tile_bottom-t+1)*SS
    rr = Image.new("L",(rw,rh),0)
    ImageDraw.Draw(rr).rounded_rectangle([0,0,rw-1,rh-1], radius=int(side*radius_pct*SS), fill=255)
    rr = rr.resize((r-l+1, tile_bottom-t+1), Image.LANCZOS)
    rrfull = Image.new("L",(W,H),0); rrfull.paste(rr,(l,t)); rrm = np.array(rrfull)
    keep = sil & ((rrm>8) | satm)
    alpha = np.where(keep, np.maximum(rrm, np.where(satm,255,0)), 0).astype(np.uint8)
    al = Image.fromarray(alpha,"L").filter(ImageFilter.GaussianBlur(0.5))
    out = im.copy(); out.putalpha(al)
    return out.crop(out.getbbox())

MASTER = load_rounded_master()
log("rounded master", MASTER.size)

def _tight_master():
    # Crop bỏ QUẦNG GLOW trong suốt (alpha thấp) → chỉ còn TILE đặc → icon lấp đầy, logo TO, KHÔNG cắt nội dung.
    # (Admin Demo 5/8: icon app logo to tối đa, hạn chế viền, cấm cắt mất ảnh.)
    a = np.array(MASTER.split()[3])
    ys,xs = np.where(a > 140)
    if len(xs)==0: return MASTER
    m = int(min(MASTER.size)*0.02)
    l=max(0,int(xs.min())-m); t=max(0,int(ys.min())-m)
    r=min(MASTER.size[0],int(xs.max())+m); b=min(MASTER.size[1],int(ys.max())+m)
    return MASTER.crop((l,t,r,b))
TIGHT = _tight_master()
log("tight (icon) master", TIGHT.size)

def fit_square(size, src=None):
    """đặt ảnh vào canvas vuông trong suốt, giữ tỉ lệ, không méo, KHÔNG cắt."""
    m = (src if src is not None else MASTER).copy(); m.thumbnail((size,size), Image.LANCZOS)
    canv = Image.new("RGBA",(size,size),(0,0,0,0))
    canv.alpha_composite(m, ((size-m.size[0])//2,(size-m.size[1])//2))
    return canv

def save_png(p,size):   fit_square(size, TIGHT).save(p)   # ICON/favicon = tile lấp đầy (ít viền)
def save_webp(p,size):  fit_square(size, MASTER).save(p,"WEBP",lossless=True,quality=95)  # logo inline giữ glow

def save_ico(p,sizes):
    # base = ảnh LỚN NHẤT (electron-builder yêu cầu icon.ico chứa >=256x256; đọc size theo entry lớn nhất)
    sz=sorted(set(sizes), reverse=True)
    base=fit_square(sz[0], TIGHT)
    base.save(p, format='ICO', sizes=[(s,s) for s in sz])

def save_icon_bg(p,size,color):
    Image.new("RGBA",(size,size),rgb(color)+(255,)).save(p)

def save_icon_fg(p,size,pad=0.06):
    # foreground adaptive: TIGHT (tile đặc) + pad nhỏ → logo TO trong safe-zone, không cắt.
    inner=int(size*(1-2*pad)); m=TIGHT.copy(); m.thumbnail((inner,inner),Image.LANCZOS)
    canv=Image.new("RGBA",(size,size),(0,0,0,0))
    canv.alpha_composite(m,((size-m.size[0])//2,(size-m.size[1])//2)); canv.save(p)

def grad_bg(w,h,c1,c2,angle=160):
    base=Image.new("RGB",(w,h)); px=base.load()
    import math
    a=math.radians(angle); dx,dy=math.cos(a),math.sin(a)
    for y in range(h):
        for x in range(w):
            t=((x/w)*dx+(y/h)*dy+1)/2; t=max(0,min(1,t))
            px[x,y]=tuple(int(c1[i]+(c2[i]-c1[i])*t) for i in range(3))
    return base

def font(sz,bold=True):
    for f in (["arialbd.ttf","arial.ttf"] if bold else ["arial.ttf"]):
        try: return ImageFont.truetype("C:/Windows/Fonts/"+f,sz)
        except: pass
    return ImageFont.load_default()

def save_og(p,w=1200,h=630):
    bg=grad_bg(w,h,rgb(TOK["colors"]["brand-tint"]),rgb("#d6e9f8")).convert("RGBA")
    m=MASTER.copy(); m.thumbnail((int(h*0.62),int(h*0.62)),Image.LANCZOS)
    bg.alpha_composite(m,(int(w*0.14),(h-m.size[1])//2))
    d=ImageDraw.Draw(bg)
    d.text((int(w*0.44),int(h*0.40)),TOK["name"],font=font(120),fill=rgb(TOK["colors"]["brand-hover"]))
    bg.convert("RGB").save(p)

def save_header_bmp(p,keep=True):
    """NSIS header ~150x57: logo canh phai, nen tint. Giu size file cu neu co."""
    w,hh=150,57
    if keep and p.exists():
        try: w,hh=Image.open(p).size
        except: pass
    canv=Image.new("RGB",(w,hh),rgb(TOK["colors"]["brand-tint"]))
    m=MASTER.copy(); m.thumbnail((hh-8,hh-8),Image.LANCZOS)
    canv.paste(m,(w-m.size[0]-8,(hh-m.size[1])//2),m); canv.save(p,"BMP")

def save_sidebar_bmp(p,keep=True):
    """NSIS sidebar ~164x314: logo tren, nen gradient brand. Giu size cu."""
    w,hh=164,314
    if keep and p.exists():
        try: w,hh=Image.open(p).size
        except: pass
    canv=grad_bg(w,hh,rgb(TOK["gradientBrand"][0]),rgb(TOK["gradientBrand"][1]))
    m=MASTER.copy(); m.thumbnail((int(w*0.66),int(w*0.66)),Image.LANCZOS)
    canv.paste(m,((w-m.size[0])//2,int(hh*0.10)),m); canv.save(p,"BMP")

def save_header_ico(p):
    """installerHeaderIcon.ico landscape ~150x57."""
    w,hh=150,57
    if p.exists():
        try: w,hh=Image.open(p).size
        except: pass
    canv=Image.new("RGBA",(w,hh),(0,0,0,0))
    m=MASTER.copy(); m.thumbnail((hh,hh),Image.LANCZOS)
    canv.alpha_composite(m,(4,(hh-m.size[1])//2)); canv.save(p,"ICO")

# ---------- 2) TARGETS (moi surface, 2 product) ----------
ICO=[16,24,32,48,64,128,256]
def T(rel): return ROOT/rel
def do(rel,fn):
    p=T(rel); p.parent.mkdir(parents=True,exist_ok=True); fn(p); return str(rel)

def gen_all():
    out=[]
    # ---- SigMa: inline logo webp + source ----
    for base in ["apps/web-demo/src/assets","apps/landing/src/assets"]:
        out.append(do(f"{base}/alpha-logo.webp", lambda p: save_webp(p,512)))
        out.append(do(f"{base}/alpha-logo-source.png", lambda p: save_png(p,1024)))
    # ---- SigMa web favicon / PWA ----
    pub="apps/web-demo/public"
    out.append(do(f"{pub}/favicon.ico", lambda p: save_ico(p,[16,32,48,64,128,256])))
    out.append(do(f"{pub}/favicon-16.png", lambda p: save_png(p,16)))
    out.append(do(f"{pub}/favicon-32.png", lambda p: save_png(p,32)))
    out.append(do(f"{pub}/apple-touch-icon.png", lambda p: save_png(p,180)))
    out.append(do(f"{pub}/icon-192.png", lambda p: save_png(p,192)))
    out.append(do(f"{pub}/icon-512.png", lambda p: save_png(p,512)))
    out.append(do(f"{pub}/og-image.png", lambda p: save_og(p)))
    # ---- SigMa electron/capacitor icon source ----
    res="apps/web-demo/resources"
    out.append(do(f"{res}/icon.png", lambda p: save_png(p,1024)))
    out.append(do(f"{res}/icon-foreground.png", lambda p: save_icon_fg(p,1024)))
    out.append(do(f"{res}/icon-background.png", lambda p: save_icon_bg(p,1024,TOK["icon"]["background"])))
    # ---- SigMa PC ----
    out.append(do("apps/sigma-pc/build/icon.ico", lambda p: save_ico(p,ICO)))
    # ---- Quan Ly SigMa (desktop) ----
    db="apps/desktop/build"
    out.append(do(f"{db}/icon.ico", lambda p: save_ico(p,ICO)))
    for s in [16,32,192,512]: out.append(do(f"{db}/icon-{s}.png", lambda p,s=s: save_png(p,s)))
    out.append(do(f"{db}/icon-preview.png", lambda p: save_png(p,512)))
    out.append(do(f"{db}/installerHeaderIcon.ico", lambda p: save_header_ico(p)))
    # NSIS wizard BMP (bit ho agent bao) — giu size cu neu co
    for bmp in ["installerHeader.bmp"]:
        pth=f"{db}/{bmp}"
        if T(pth).exists(): out.append(do(pth, lambda p: save_header_bmp(p)))
    for bmp in ["installerSidebar.bmp","uninstallerSidebar.bmp"]:
        pth=f"{db}/{bmp}"
        if T(pth).exists(): out.append(do(pth, lambda p: save_sidebar_bmp(p)))
    out.append(do("apps/desktop/src/renderer/src/assets/alpha-logo.webp", lambda p: save_webp(p,512)))
    if T("apps/desktop/src/renderer/src/assets/alpha-logo-source.png").exists():
        out.append(do("apps/desktop/src/renderer/src/assets/alpha-logo-source.png", lambda p: save_png(p,1024)))
    # ---- mobile (legacy) ----
    if T("apps/mobile/src/assets/logo.png").exists():
        out.append(do("apps/mobile/src/assets/logo.png", lambda p: save_png(p,512)))
    return out

# ---------- 3) brand.css (token + button GLASS) ----------
def build_css():
    c=TOK["colors"]; g=TOK["gradientBrand"]; s=TOK["surface"]; b=TOK["button"]
    vars="\n".join(f"  --color-{k}: {v};" for k,v in c.items())
    def rgba(h,a):
        h=h.lstrip('#'); return f"rgba({int(h[0:2],16)},{int(h[2:4],16)},{int(h[4:6],16)},{a})"
    glow=rgba(b['glow'],.55); glow2=rgba(b['glow'],.7)
    R=b['radius']
    # NUT = PILL GLASS theo ANH THAM CHIEU Admin Demo (5/8): gradient cyan sang->dam, VIEN RIM cyan, gloss tren, glow ngoai.
    # CHI ap mau/chuyen-mau/vien tu tham chieu. GIU font he thong (khong set font-family). Chu dam (font-weight 700).
    return f"""/* === BRAND STUDIO (tu dong sinh boi scripts/brand_sync.py — DUNG SUA TAY) === */
/* Doi brand: sua assets/brand/brand.tokens.json + thay icon master -> npm run brand:sync */
@theme {{
{vars}
  --gradient-brand: linear-gradient(160deg, {g[0]}, {g[1]});
  --gradient-accent: linear-gradient(180deg, {b['top']} 0%, {b['mid']} 45%, {b['bottom']} 100%);
  --radius-tile: {s['radiusTile']};
  --radius-button: {R};
}}
/* Button = PILL GLASS (mau/chuyen-mau/vien lay tu anh tham chieu, dam hon ~10%). Giu font he thong SigMa. */
.btn-primary,.btn-teal,.btn-soft,.btn-danger{{position:relative;overflow:hidden;border-radius:{R};font-weight:700;
  transition:transform .12s ease,box-shadow .12s ease,filter .12s ease;-webkit-font-smoothing:antialiased}}
.btn-primary::before,.btn-teal::before,.btn-soft::before,.btn-danger::before{{content:"";position:absolute;left:6px;right:6px;top:2px;height:46%;
  border-radius:{R};background:linear-gradient(180deg,rgba(255,255,255,.85),rgba(255,255,255,0));pointer-events:none}}
.btn-primary:active,.btn-teal:active,.btn-soft:active,.btn-danger:active{{transform:translateY(1px)}}
.btn-primary{{color:#fff;text-shadow:0 1px 2px rgba(10,74,120,.55);
  background:linear-gradient(180deg,{b['top']} 0%,{b['mid']} 45%,{b['bottom']} 100%);
  border:2px solid {b['rim']};
  box-shadow:0 0 0 1px {rgba(b['rim'],.55)},0 0 16px 2px {glow},inset 0 2px 3px rgba(255,255,255,.9),inset 0 -8px 13px {rgba(b['bottom'],.5)}}}
.btn-primary:hover{{filter:brightness(1.05);box-shadow:0 0 0 1px {rgba(b['rim'],.65)},0 0 24px 4px {glow2},inset 0 2px 3px rgba(255,255,255,.95),inset 0 -8px 13px {rgba(b['bottom'],.55)}}}
.btn-teal{{color:#fff;text-shadow:0 1px 2px rgba(8,86,92,.55);
  background:linear-gradient(180deg,{b['tealTop']} 0%,#5fd0d8 45%,{b['tealBottom']} 100%);
  border:2px solid #a9eef2;
  box-shadow:0 0 0 1px rgba(120,225,230,.55),0 0 16px 2px rgba(59,195,208,.5),inset 0 2px 3px rgba(255,255,255,.9),inset 0 -8px 13px {rgba(b['tealBottom'],.5)}}}
.btn-teal:hover{{filter:brightness(1.05)}}
.btn-soft{{color:{c['brand-hover']};
  background:linear-gradient(180deg,{b['softTop']} 0%,{b['softBottom']} 100%);
  border:2px solid {b['rim']};
  box-shadow:0 0 12px rgba(94,174,222,.4),inset 0 2px 3px #fff}}
.btn-soft:hover{{filter:brightness(1.02)}}
.btn-danger{{color:#fff;text-shadow:0 1px 2px rgba(120,20,20,.5);
  background:linear-gradient(180deg,#ff9a9a 0%,#f26363 45%,#d92d2d 100%);
  border:2px solid #ffc2c2;
  box-shadow:0 0 0 1px rgba(255,180,180,.55),0 0 16px 2px rgba(226,59,59,.45),inset 0 2px 3px rgba(255,255,255,.7),inset 0 -8px 13px rgba(180,30,30,.4)}}
.btn-danger:hover{{filter:brightness(1.05)}}
.card-glass{{border-radius:var(--radius-tile);
  background:linear-gradient(160deg,rgba(255,255,255,.9),{c['brand-tint']} 70%,#dcebf8);
  border:1px solid rgba(255,255,255,.7);box-shadow:0 10px 30px rgba(24,119,214,.16),inset 0 1px 0 #fff}}
"""

CSS_TARGETS=[
    "apps/web-demo/src/brand.css",
    "apps/landing/src/brand.css",
    "apps/desktop/src/renderer/src/brand.css",
]
def write_css():
    css=build_css(); (BRAND/"brand.css").write_text(css,encoding="utf-8")
    written=[]
    for rel in CSS_TARGETS:
        p=T(rel)
        if p.parent.exists():
            p.write_text(css,encoding="utf-8"); written.append(rel)
    return written

# ---------- 4) run ----------
def main():
    files=gen_all()
    log(f"generated {len(files)} raster asset")
    css_files=write_css()
    log(f"brand.css -> assets/brand/brand.css + {len(css_files)} app")
    if ANDROID:
        wd=ROOT/"apps/web-demo"
        log("capacitor-assets generate --android ...")
        r=subprocess.run(["npx","capacitor-assets","generate","--android",
            "--iconBackgroundColor",TOK["icon"]["background"],
            "--iconBackgroundColorDark",TOK["icon"]["backgroundDark"]],
            cwd=wd,shell=True)
        subprocess.run(["npx","cap","sync","android"],cwd=wd,shell=True)
        log("android exit",r.returncode)
    print("\n=== SUMMARY ===")
    for f in files: print("  ",f)
    for f in css_files: print("   css:",f)
    print("OK. Rebuild app de ap dung. (them --android de sinh mipmap/splash APK)")

if __name__=="__main__":
    main()
