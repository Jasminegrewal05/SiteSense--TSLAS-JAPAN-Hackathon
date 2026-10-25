import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../api";

// QR code that opens the recording screen on a phone on the same wifi.
// With `visitId`, the code also pairs the phone: no sign-in on the phone, and that phone
// can only record this visit. The code is single-use and changes every few minutes.
export default function PhoneHandoff({ path, visitId, title, children }) {
  const [url, setUrl] = useState("");
  const [qr, setQr] = useState("");
  const [paired, setPaired] = useState(false);

  useEffect(() => {
    let stop = false;

    async function base() {
      const host = window.location.hostname;
      if (host !== "localhost" && host !== "127.0.0.1") return window.location.origin;
      // On the laptop, swap "localhost" for the laptop's wifi address so the phone can reach it.
      try {
        const d = await api.network();
        if (d.lan_ip) return window.location.protocol + "//" + d.lan_ip + ":" + window.location.port;
      } catch {
        /* fall through */
      }
      return window.location.origin;
    }

    async function refresh() {
      const origin = await base();
      let u = origin + path;
      let withCode = false;
      if (visitId) {
        try {
          const d = await api.pairCode(visitId);
          u = origin + "/pair/" + d.code;
          withCode = true;
        } catch {
          /* a manager, or the checklist is not locked: plain link */
        }
      }
      if (stop) return;
      setUrl(u);
      setPaired(withCode);
      QRCode.toDataURL(u, { margin: 1, width: 240, color: { dark: "#252a6b", light: "#ffffff" } })
        .then((img) => !stop && setQr(img))
        .catch(() => {});
    }

    refresh();
    const timer = visitId ? setInterval(refresh, 8 * 60 * 1000) : null;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [path, visitId]);

  return (
    <div className="bg-white border border-line rounded-xl p-5 flex flex-col sm:flex-row gap-5 items-start">
      {qr && <img src={qr} alt={"QR code: " + title} width={168} height={168} className="rounded-lg border border-line" />}
      <div className="min-w-0">
        <h3 className="text-xl font-bold">{title}</h3>
        <div className="text-base text-sub mt-1 max-w-md">{children}</div>
        {paired ? (
          <p className="text-sm text-sub mt-3">The code works once and changes every few minutes.</p>
        ) : (
          url && <p className="num text-sm mt-3 break-all text-ink">{url}</p>
        )}
      </div>
    </div>
  );
}
