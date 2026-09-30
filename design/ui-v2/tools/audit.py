"""Zold UI audit. Usage: python3 tools/audit.py screens/*.html
The scriptable subset of RULES.md. It does not replace reading the two skills."""
import re, glob, os, sys, json
from html.parser import HTMLParser
LIG = set("add add_link arrow_back arrow_downward arrow_forward account_balance account_balance_wallet attach_file attach_money attach_money badge block bolt call_received check check_circle chevron_right close code construction contacts content_copy currency_exchange description domain download draw edit edit_note error expand_more fact_check fingerprint folder_zip fullscreen gpp_maybe group group_add help home hourglass_top hub inbox install_mobile ios_share key laptop_mac link link_off lock logout mail menu menu_book more_horiz move_to_inbox north_east notifications open_in_new passkey password person person_add phone_iphone picture_as_pdf radio_button_unchecked receipt_long refresh restore rule schedule science search send settings shield shield_lock sms smartphone south speed support_agent swap_vert sync_problem table_view touch_app unfold_more upload_file verified_user visibility wifi_off workspace_premium".split())

class A(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True); s.stack=[]; s.issues=[]; s.labels_for=set(); s.inputs=[]; s.in_label=0; s.text=[]
        s.clickables=[]; s.cur=None; s.headings=[]; s.script=0; s.style=0; s.hidden=0
    def handle_starttag(s,t,a):
        a=dict(a); st=a.get("style","") or ""
        s.stack.append((t,a))
        if t=="script": s.script+=1
        if t=="style": s.style+=1
        if t=="label":
            s.in_label+=1
            if "for" in a: s.labels_for.add(a["for"])
        if t in("input","select","textarea"):
            s.inputs.append((t,a,s.in_label>0))
        if t=="img":
            if "alt" not in a: s.issues.append("img without alt")
            if "width" not in a or "height" not in a: s.issues.append("img without width/height")
        if t in("a","button"):
            s.clickables.append({"t":t,"a":a,"text":"","depth":len(s.stack)})
            m=re.search(r"(?<![-\w])height:\s*(\d+)px",st)
            if m and int(m.group(1))<36 and "hidden" not in st: s.issues.append(f"small target {t} h={m.group(1)}px")
            if t=="a" and a.get("href")=="#": s.issues.append("dead link href=#")
        if re.fullmatch(r"h[1-6]",t): s.headings.append(int(t[1]))
        if t in("input","img","meta","link","br","source"): s.stack.pop()
    def handle_endtag(s,t):
        if t=="script": s.script-=1
        if t=="style": s.style-=1
        if t=="label": s.in_label-=1
        if t in("a","button") and s.clickables:
            c=[c for c in s.clickables if c["t"]==t and "done" not in c]
            if c:
                c=c[-1]; c["done"]=1
                txt=c["text"].strip()
                words=[w for w in re.split(r"\s+",txt) if w]
                if (not words or all(w in LIG for w in words)) and not c["a"].get("aria-label"):
                    s.issues.append(f"icon-only {t} without aria-label ({txt[:20]})")
        while s.stack:
            x=s.stack.pop()
            if x[0]==t: break
    def handle_data(s,d):
        if s.script or s.style: return
        for c in s.clickables:
            if "done" not in c: c["text"]+=d
        s.text.append(d)


# Plain-language gate (RULES.md, "Words"). Checked in visible text only, icon ligatures removed.
JARGON = [r"\bSEPA\b", r"\bpasskeys?\b", r"\bEURe\b", r"\bsmart account\b", r"\bSafe\b", r"\bon-?chain\b",
          r"\bSepolia\b", r"\bstablecoins?\b", r"\bgas\b", r"\bUserOp", r"\bsigners?\b", r"\bmultisig\b", r"\bthreshold\b",
          r"\bERC-?20\b", r"\bslippage\b", r"\bmid rate\b"]
ALLOW = [r"passkey on your device, the same kind of sign-in", r"Safe\s*·\s*the account", r"Only USDC on the Base network",
         r"\bAPI key", r"ID verification \(KYC\)"]
BLOCKS = r"</?(?:span|p|div|li|h[1-6]|td|th|button|a|label|section|header|footer|main|nav)\b[^>]*>"
ICON = r'<span class="ms"[^>]*>[^<]*</span>'


def audit(path, legal=False):
    src = open(path, encoding="utf-8").read()
    m = re.search(r"</helmet>(.*)</x-dc>", src, re.S) or re.search(r"<body[^>]*>(.*)</body>", src, re.S)
    body = m.group(1) if m else src
    a = A(); a.feed(body)
    iss = list(a.issues)
    txt = " ".join(a.text)
    b2 = A(); b2.feed(re.sub(ICON, "", body)); vtxt = " ".join(b2.text)
    for ch, name in [("—", "em-dash"), ("–", "en-dash"), ("...", "three dots, use …")]:
        if ch in vtxt: iss.append(f"{name} in text")
    if re.search(r"[A-Za-z]'[A-Za-z]", vtxt): iss.append("straight apostrophe, use ’")
    vis = re.sub(r"<(script|style)[\s\S]*?</\1>", "", body)
    for blk in re.split(BLOCKS, vis):
        t = re.sub(r"<[^>]+>", "", blk)
        if t.count("·") > 1: iss.append(f"more than one middle dot in a line: {t.strip()[:50]}")
    if not legal:
        plain = vtxt
        for al in ALLOW: plain = re.sub(al, "", plain)
        for j in JARGON:
            mm = re.search(j, plain)
            if mm: iss.append(f"jargon '{mm.group(0)}' (see RULES.md, Words)")
    for t, at, wrapped in a.inputs:
        if at.get("type") in ("hidden", "submit"): continue
        if not wrapped and at.get("id") not in a.labels_for and not at.get("aria-label"): iss.append(f"{t} without label")
        if t in ("input", "textarea") and at.get("type") not in ("checkbox", "radio"):
            if not at.get("name"): iss.append(f"{t} without name")
            if not at.get("autocomplete"): iss.append(f"{t} without autocomplete")
            ph = at.get("placeholder")
            if ph and not ph.endswith("…"): iss.append(f"placeholder without …: {ph}")
            if (at.get("type") == "email" or "code" in (at.get("name") or "")) and at.get("spellcheck") != "false":
                iss.append("email/code input without spellcheck=false")
    hs = a.headings
    if hs.count(1) > 1: iss.append("more than one h1")
    if 1 not in hs: iss.append("no h1 (add a visually hidden one if the design shows none)")
    for x, y in zip(hs, hs[1:]):
        if y > x + 1: iss.append(f"heading level skips h{x} to h{y}"); break
    if re.search(r"\b(Acme|John Doe|Jane Doe|Lorem)\b", txt): iss.append("generic placeholder name")
    if re.search(r"color:\s*#5b5b66", body): iss.append("#5b5b66 text fails contrast, use dim #9a9aa5")
    if re.search(r"[\U0001F300-\U0001FAFF]", txt): iss.append("emoji in UI")
    if "transition:all" in src.replace(" ", ""): iss.append("transition: all")
    if re.search(r"#000(000)?\b", src, re.I): iss.append("pure black #000")
    return iss


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Zold UI audit: the scriptable part of design-taste-frontend and the Web Interface Guidelines.")
    ap.add_argument("files", nargs="+", help="HTML files or globs. For JS-rendered pages, save the rendered DOM first with tools/snapshot.mjs")
    ap.add_argument("--legal", nargs="*", default=["Imprint", "Terms", "Privacy", "Regulatory"], help="names exempt from the jargon gate")
    ap.add_argument("--desktop", nargs="*", default=["Desk-"], help="name prefixes where mouse targets of 24 to 39px are fine")
    args = ap.parse_args()
    paths = sorted({p for f in args.files for p in (glob.glob(f) or [f])})
    bad = 0
    for p in paths:
        n = os.path.basename(p)
        iss = audit(p, legal=any(l in n for l in args.legal))
        if any(n.startswith(d) for d in args.desktop):
            iss = [i for i in iss if not re.match(r"small target .* h=(2[4-9]|3\d)px", i)]
        if iss:
            bad += 1
            print(f"\n{n}")
            for i, c in sorted({i: iss.count(i) for i in iss}.items()): print(f"  - {i}" + (f"  (x{c})" if c > 1 else ""))
    print(f"\n{len(paths)} files, {bad} with findings")
    sys.exit(1 if bad else 0)
