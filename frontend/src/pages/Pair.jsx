import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";

// Opened by scanning the laptop's QR code. Pairs this phone to one visit, then opens recording.
export default function Pair() {
  const { code } = useParams();
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .pairPhone(code)
      .then((d) => window.location.replace("/visits/" + d.visit + "/capture"))
      .catch((e) => setError(e.message));
  }, [code]);

  return (
    <div className="min-h-screen bg-[#171b45] text-white grid place-items-center px-6 text-center">
      {error ? (
        <div>
          <h1 className="text-2xl font-bold">Could not connect this phone</h1>
          <p className="text-lg text-white/80 mt-3">{error}</p>
        </div>
      ) : (
        <p className="text-xl font-bold">Connecting this phone...</p>
      )}
    </div>
  );
}
