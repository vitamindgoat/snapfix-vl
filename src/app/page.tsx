"use client";

import { useEffect, useRef, useState } from "react";
import { getMalexSnapfixContractorsUrl } from "@/lib/malex-edge";
import { ensureMalexAccessToken, malexAuthHeaders } from "@/lib/malex-token";
import { GpuLoadingBanner } from "@/components/GpuLoadingBanner";
import { MalexInstanceStatusPill } from "@/components/MalexInstanceStatusPill";

type SnapfixAnalysis = {
  detected: boolean;
  category: string;
  issue: string;
  trade: string;
  recommendation: string;
};

type ContractorRow = {
  name: string;
  phone: string;
  rating: number;
  distance: string;
  reason: string;
};

type SnapfixResponse = {
  analysis: SnapfixAnalysis;
  contractors: ContractorRow[];
  search_warning?: string | null;
  rerank_warning?: string | null;
};

type DatasetManifest = {
  files: string[];
};

function isSnapfixPayload(x: unknown): x is SnapfixResponse {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const a = o.analysis;
  if (!a || typeof a !== "object") return false;
  const aa = a as Record<string, unknown>;
  return (
    typeof aa.detected === "boolean" &&
    Array.isArray(o.contractors)
  );
}

async function fetchDatasetImageDataUrl(filename: string): Promise<string> {
  const res = await fetch(`/dataset/${encodeURIComponent(filename)}`);
  if (!res.ok) {
    throw new Error(`Failed to load dataset image (${res.status})`);
  }
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read dataset image"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read dataset image"));
    reader.readAsDataURL(blob);
  });
}

export default function SnapfixPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<string | null>(null);
  const [city, setCity] = useState("Folsom CA 95630");
  const [datasetFiles, setDatasetFiles] = useState<string[]>([]);
  const [selectedDataset, setSelectedDataset] = useState("");
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [loadingDatasetImage, setLoadingDatasetImage] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<SnapfixResponse | null>(null);
  const [httpError, setHttpError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/dataset/manifest.json");
        if (!res.ok) return;
        const manifest = (await res.json()) as DatasetManifest;
        if (!cancelled && Array.isArray(manifest.files)) {
          setDatasetFiles(manifest.files);
        }
      } catch {
        // Best-effort: hide dropdown when manifest is unavailable.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setDatasetError(null);
    setSelectedDataset("");

    const reader = new FileReader();
    reader.onloadend = () => {
      setImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleDatasetSelect = async (filename: string) => {
    setSelectedDataset(filename);
    setDatasetError(null);

    if (!filename) {
      setImage(null);
      return;
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    setLoadingDatasetImage(true);
    try {
      const dataUrl = await fetchDatasetImageDataUrl(filename);
      setImage(dataUrl);
    } catch (e) {
      console.error(e);
      setImage(null);
      setDatasetError("Could not load the selected dataset image.");
    } finally {
      setLoadingDatasetImage(false);
    }
  };

  const handleProceed = async () => {
    if (!image) return;

    setIsLoading(true);
    setResult(null);
    setHttpError(null);

    try {
      await ensureMalexAccessToken();
      const res = await fetch(getMalexSnapfixContractorsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...malexAuthHeaders() },
        body: JSON.stringify({
          image_base64: image,
          location: city,
        }),
      });

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        setHttpError(`Request failed (${res.status}); response was not JSON.`);
        return;
      }

      if (!res.ok) {
        const msg =
          body &&
          typeof body === "object" &&
          body !== null &&
          "detail" in body &&
          typeof (body as { detail?: unknown }).detail === "string"
            ? (body as { detail: string }).detail
            : JSON.stringify(body);
        setHttpError(`Request failed (${res.status}): ${msg}`);
        return;
      }

      if (!isSnapfixPayload(body)) {
        setHttpError("Malformed SNAPFIX JSON from edge.");
        return;
      }

      setResult(body);
    } catch (e) {
      console.error(e);
      setHttpError("Network or runtime error.");
    } finally {
      setIsLoading(false);
    }
  };

  const runDisabled = !image || isLoading || loadingDatasetImage;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6 min-h-screen bg-white text-black">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold">Snapfix Diagnosis</h1>
        <MalexInstanceStatusPill />
      </div>
      <p className="text-sm text-gray-600">
        Image → Qwen vision → Google Places candidates → ModernBERT rerank via Malex GPU worker.
        Verify phone/hours on Google Maps before calling.
      </p>

      <GpuLoadingBanner />

      <div className="space-y-4 border p-4 rounded-lg">
        {datasetFiles.length > 0 && (
          <div>
            <label htmlFor="snapfix-dataset" className="block mb-1 font-medium">
              Dataset image
            </label>
            <select
              id="snapfix-dataset"
              value={selectedDataset}
              onChange={(e) => void handleDatasetSelect(e.target.value)}
              disabled={loadingDatasetImage}
              className="w-full border p-2 rounded bg-white"
            >
              <option value="">Choose from dataset…</option>
              {datasetFiles.map((filename) => (
                <option key={filename} value={filename}>
                  {filename}
                </option>
              ))}
            </select>
            {loadingDatasetImage && (
              <p className="text-sm text-gray-600 mt-1">Loading dataset image…</p>
            )}
            {datasetError && (
              <p className="text-sm text-red-700 mt-1">{datasetError}</p>
            )}
          </div>
        )}

        <div>
          <label htmlFor="snapfix-photo" className="block mb-1 font-medium">
            Upload Image
          </label>
          <input
            ref={fileInputRef}
            id="snapfix-photo"
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="block w-full"
          />
        </div>

        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="Preview" className="max-h-64 rounded-md" />
        )}

        <div>
          <label htmlFor="snapfix-city" className="block mb-1 font-medium">
            Location
          </label>
          <input
            id="snapfix-city"
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="w-full border p-2 rounded"
          />
        </div>

        <button
          disabled={runDisabled}
          onClick={handleProceed}
          className="w-full bg-blue-600 text-white p-2 rounded disabled:opacity-50"
        >
          {isLoading ? "Analyzing…" : "Run SNAPFIX"}
        </button>
      </div>

      {httpError && (
        <div className="border border-red-200 bg-red-50 text-red-900 p-3 rounded whitespace-pre-wrap text-sm">
          {httpError}
        </div>
      )}

      {result && (
        <div className="border p-4 rounded-lg bg-gray-50 space-y-4">
          <h2 className="font-semibold text-lg">Analysis</h2>
          <ul className="text-sm space-y-1">
            <li>
              <span className="font-medium">Detected:</span>{" "}
              {result.analysis.detected ? "yes" : "no"}
            </li>
            <li>
              <span className="font-medium">Category:</span>{" "}
              {result.analysis.category || "—"}
            </li>
            <li>
              <span className="font-medium">Issue:</span>{" "}
              {result.analysis.issue || "—"}
            </li>
            <li>
              <span className="font-medium">Trade:</span>{" "}
              {result.analysis.trade || "—"}
            </li>
            <li>
              <span className="font-medium">Recommendation:</span>{" "}
              {result.analysis.recommendation || "—"}
            </li>
          </ul>

          {result.search_warning && (
            <p className="text-amber-800 text-sm">{result.search_warning}</p>
          )}
          {result.rerank_warning && (
            <p className="text-amber-800 text-sm">{result.rerank_warning}</p>
          )}

          <h3 className="font-semibold">Top contractors</h3>
          {result.contractors.length === 0 ? (
            <p className="text-gray-600 text-sm">None returned.</p>
          ) : (
            <ul className="space-y-3">
              {result.contractors.map((c) => (
                <li key={`${c.name}-${c.phone}`} className="border-b pb-2 text-sm">
                  <div className="font-semibold">{c.name}</div>
                  <div>Phone: {c.phone}</div>
                  <div>
                    Rating: {c.rating.toFixed(1)} · Distance: {c.distance}
                  </div>
                  <div className="text-gray-700 mt-1">{c.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
