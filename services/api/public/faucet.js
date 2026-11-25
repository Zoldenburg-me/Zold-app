(() => {
  const $ = (id) => document.getElementById(id);
  const EXPLORERS = { 84532: "https://sepolia.basescan.org", 11155111: "https://sepolia.etherscan.io" };
  const CHAINS = { 84532: "Base Sepolia", 11155111: "Ethereum Sepolia", 31337: "a local test chain" };
  let explorer = "";

  // An address from a link (?address=0x…) is filled in, nothing more.
  const fromLink = new URLSearchParams(location.search).get("address");
  if (fromLink && /^0x[0-9a-fA-F]{40}$/.test(fromLink)) $("addr").value = fromLink;

  const say = (text, kind, link) => {
    const m = $("msg");
    m.className = `msg ${kind || ""}`;
    m.textContent = text;
    if (link) {
      m.append(" ");
      const a = document.createElement("a");
      a.href = link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "See the transaction";
      m.append(a);
    }
  };

  async function load() {
    const [faucet, health] = await Promise.all([
      fetch("/api/faucet").then((r) => r.json().then((b) => ({ ok: r.ok, b }))),
      fetch("/api/health").then((r) => r.json()).catch(() => ({})),
    ]);
    $("card").setAttribute("aria-busy", "false");
    if (!faucet.ok || !faucet.b.tokens?.length) {
      $("lede").textContent = "This deployment has no test faucet.";
      return;
    }
    explorer = EXPLORERS[health.chainId] || "";
    $("chain").textContent = CHAINS[health.chainId] || `chain ${health.chainId}`;
    $("lede").textContent = `Get test tokens to try paying an invoice or a payment link. One drip per address and token every ${faucet.b.cooldownHours} hours.`;
    const toks = $("toks");
    faucet.b.tokens.forEach((t, i) => {
      const lab = document.createElement("label");
      lab.className = "tok";
      const input = document.createElement("input");
      input.type = "radio"; input.name = "token"; input.value = t.symbol; input.checked = i === 0;
      const span = document.createElement("span");
      const b = document.createElement("b"); b.textContent = t.symbol;
      const small = document.createElement("small"); small.textContent = `${t.amount} per drip`;
      span.append(b, small);
      lab.append(input, span);
      toks.append(lab);
    });
    $("form").classList.remove("hidden");
    $("notes").hidden = false;
  }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const address = $("addr").value.trim();
    const token = new FormData($("form")).get("token");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      say("Enter a wallet address: 0x followed by 40 hex characters.", "err");
      $("addr").focus();
      return;
    }
    $("go").disabled = true;
    say(`Sending ${token}… this takes a few seconds.`);
    try {
      const r = await fetch("/api/faucet/drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, token }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        const when = b.retryAt ? ` You can try again ${new Date(b.retryAt).toLocaleString()}.` : "";
        const why = (b.error || "the faucet could not send").replace(/^./, (c) => c.toUpperCase());
        say(`${why}.${when}`, "err");
      } else {
        say(`Sent ${b.amount} ${b.symbol} to ${b.to.slice(0, 6)}…${b.to.slice(-4)}.`, "ok", explorer ? `${explorer}/tx/${b.txHash}` : "");
      }
    } catch {
      say("Zold could not be reached. Check your connection and try again.", "err");
    } finally {
      $("go").disabled = false;
    }
  });

  load().catch(() => { $("lede").textContent = "The faucet could not be loaded. Try again shortly."; });
})();
