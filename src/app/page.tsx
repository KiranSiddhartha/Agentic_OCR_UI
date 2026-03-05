"use client"

import { useEffect, useRef, useState } from "react"
import DocumentPreview from "@/components/DocumentPreview"
import FieldsPanel from "@/components/FieldsPanel"
import SummaryPanel from "@/components/SummaryPanel"
import Tabs from "@/components/Tabs"
import { Pie } from "react-chartjs-2"
import { ArcElement, Chart as ChartJS, Legend, Tooltip } from "chart.js"
import type { Field as FieldType } from "@/components/FieldsPanel"

ChartJS.register(ArcElement, Tooltip, Legend)
const SHOW_FILENAMES_IN_PREVIEW = true
const PREVIEW_WIDTH_PERCENT = 45 // change to 40 for 40/60 layout
const OUTPUT_WIDTH_PERCENT = 100 - PREVIEW_WIDTH_PERCENT
const formatFieldLabel = (name: string) =>
  name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")

interface AnalyzeResponse {
  document_type: string
  policy_type: string
  document_type_explanation?: string
  policy_type_explanation?: string
  confidence: number
  page_count: number
  fields: Record<string, FieldType>
  pages: string[]
  processing_time: number
  raw_lines: string[]
  raw_lines_by_page?: string[][]
  expected_fields: string[]
  summary_counts: {
    perfect: number
    partial: number
    failed: number
  }
}

interface PreviewResponse {
  page_count: number
  pages: string[]
}

interface ExpandedZipFile {
  name: string
  type: string
  data_base64: string
}

interface ExpandZipResponse {
  file_count: number
  files: ExpandedZipFile[]
}

const getSummaryBreakdown = (result: AnalyzeResponse) => {
  const expected = result.expected_fields || []
  const fields = result.fields || {}
  const universe = expected.length > 0 ? expected : Object.keys(fields)
  const perfect: string[] = []
  const partial: string[] = []
  const failed: Array<{ name: string; reason: string }> = []

  for (const name of universe) {
    const fd = fields[name]
    const value = fd?.value
    if (value === undefined || value === null) {
      failed.push({ name, reason: fd?.reason || "Not extracted" })
      continue
    }
    if (typeof value === "string" && !value.trim()) {
      partial.push(name)
      continue
    }
    perfect.push(name)
  }

  return { perfect, partial, failed }
}

const classifyOcrBlock = (block: string) => {
  const trimmed = block.trim()
  if (!trimmed) return "text"
  if (trimmed.includes("|") && trimmed.includes("---")) return "table"
  const lines = trimmed.split("\n")
  const firstLine = lines[0].trim()
  const words = firstLine.split(/\s+/).filter(Boolean)
  if (
    lines.length <= 2 &&
    words.length <= 10 &&
    !/[.:]/.test(firstLine) &&
    !/\d{2,}/.test(firstLine)
  ) {
    return "section_header"
  }
  return "text"
}

const buildTypedOcrBlocks = (pageLines: string[]) => {
  const blocks = pageLines.join("\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  return blocks.map((block) => ({ type: classifyOcrBlock(block), content: block }))
}

const getFormFieldNames = (result: AnalyzeResponse) => {
  if (result.expected_fields?.length) return result.expected_fields
  return Object.keys(result.fields || {})
}

const buildExtractedFieldsClipboardText = (result: AnalyzeResponse) => {
  const ordered = getFormFieldNames(result)
  const lines: string[] = []
  for (const key of ordered) {
    const value = result.fields?.[key]?.value
    if (typeof value === "string" && value.trim()) {
      lines.push(`${formatFieldLabel(key)}: ${value}`)
    }
  }
  return lines.join("\n")
}

const base64ToUint8Array = (base64: string) => {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

export default function Home() {
  const [results, setResults] = useState<AnalyzeResponse[]>([])
  const [previewUrlsByFile, setPreviewUrlsByFile] = useState<string[][]>([])
  const [previewMediaTypesByFile, setPreviewMediaTypesByFile] = useState<string[][]>([])
  const [selectedByDoc, setSelectedByDoc] = useState<Record<number, string | null>>({})
  const [uploadedFileNames, setUploadedFileNames] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState("form")
  const [copiedDocIndex, setCopiedDocIndex] = useState<number | null>(null)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)

  useEffect(() => {
    const onScroll = () => {
      setShowBackToTop(window.scrollY > 300)
    }
    window.addEventListener("scroll", onScroll)
    onScroll()
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  const handleBack = () => {
    runIdRef.current += 1
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setResults([])
    setPreviewUrlsByFile([])
    setPreviewMediaTypesByFile([])
    setSelectedByDoc({})
    setUploadedFileNames([])
    setLoading(false)
    setActiveTab("form")
  }

  const handleUpload = async (files: FileList) => {
    const apiBases = Array.from(
      new Set(
        [
          process.env.NEXT_PUBLIC_API_BASE,
          "http://127.0.0.1:8000",
          "http://localhost:8000",
        ].filter((v): v is string => Boolean(v))
      )
    )

    const apiFetch = async (path: string, init: RequestInit) => {
      let lastErr: unknown = null
      for (const base of apiBases) {
        try {
          return await fetch(`${base}${path}`, init)
        } catch (err) {
          lastErr = err
        }
      }
      throw lastErr || new Error(`Unable to reach backend for ${path}`)
    }

    let filesArray = Array.from(files)
    if (filesArray.length === 0) return

    // Move to output screen immediately, including ZIP expansion time.
    setResults([])
    setSelectedByDoc({})
    setActiveTab("form")
    setUploadedFileNames(filesArray.map((f) => f.name))
    setLoading(true)

    // Expand ZIP uploads into individual files so existing sequential flow remains unchanged.
    const expandedQueue: File[] = []
    for (const f of filesArray) {
      const isZip = (f.type || "").toLowerCase() === "application/zip" || /\.zip$/i.test(f.name)
      if (!isZip) {
        expandedQueue.push(f)
        continue
      }
      try {
        const zipData = new FormData()
        zipData.append("file", f)
        const zipRes = await apiFetch("/expand-zip", {
          method: "POST",
          body: zipData,
        })
        const zipJson: ExpandZipResponse | { error?: string } = await zipRes.json()
        if (!zipRes.ok || !("files" in zipJson)) {
          console.error("ZIP expansion failed:", (zipJson as { error?: string }).error || "unknown error")
          continue
        }
        for (const entry of zipJson.files) {
          const bytes = base64ToUint8Array(entry.data_base64)
          expandedQueue.push(new File([bytes], entry.name, { type: entry.type || "application/octet-stream" }))
        }
      } catch (err) {
        console.error("ZIP expansion failed:", err)
      }
    }

    filesArray = expandedQueue
    if (filesArray.length === 0) {
      setLoading(false)
      return
    }

    runIdRef.current += 1
    const runId = runIdRef.current
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    const { signal } = controller

    setUploadedFileNames(filesArray.map((f) => f.name))

    // Show instant preview per file while OCR runs.
    const initialPreviews: string[][] = Array.from({ length: filesArray.length }, () => [])
    const initialMediaTypes: string[][] = Array.from({ length: filesArray.length }, () => [])
    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i]
      const fileType = (file.type || "").toLowerCase()
      const isPdf = fileType === "application/pdf" || /\.pdf$/i.test(file.name)
      if (!isPdf) {
        initialPreviews[i] = [URL.createObjectURL(file)]
        initialMediaTypes[i] = [fileType || "image/*"]
      }
    }
    setPreviewUrlsByFile(initialPreviews)
    setPreviewMediaTypesByFile(initialMediaTypes)

    const fallbackResult = (): AnalyzeResponse => ({
      document_type: "OTH",
      policy_type: "OTH",
      document_type_explanation: "Unknown document type",
      policy_type_explanation: "If policy-related information is not available in the document it will be considered as Unknown.",
      confidence: 0,
      page_count: 0,
      fields: {},
      pages: [],
      processing_time: 0,
      raw_lines: [],
      raw_lines_by_page: [],
      expected_fields: [],
      summary_counts: { perfect: 0, partial: 0, failed: 0 },
    })

    // Process one file at a time: preview -> analyze -> next file.
    for (let i = 0; i < filesArray.length; i++) {
      if (runIdRef.current !== runId || signal.aborted) break
      const file = filesArray[i]
      try {
        const previewData = new FormData()
        previewData.append("file", file)

        const previewRes = await apiFetch("/preview", {
          method: "POST",
          body: previewData,
          signal,
        })
        if (runIdRef.current !== runId || signal.aborted) break
        const previewJson: PreviewResponse = await previewRes.json()
        if (previewRes.ok && previewJson.pages?.length > 0) {
          setPreviewUrlsByFile((prev) => {
            if (runIdRef.current !== runId || signal.aborted) return prev
            const next = [...prev]
            next[i] = previewJson.pages
            return next
          })
          setPreviewMediaTypesByFile((prev) => {
            if (runIdRef.current !== runId || signal.aborted) return prev
            const next = [...prev]
            next[i] = new Array(previewJson.pages.length).fill("image/png")
            return next
          })
        }
      } catch (err) {
        if (signal.aborted) break
        console.error("Preview generation failed:", err)
      }

      const formData = new FormData()
      formData.append("file", file)
      try {
        const res = await apiFetch("/analyze", {
          method: "POST",
          body: formData,
          signal,
        })
        if (runIdRef.current !== runId || signal.aborted) break
        if (!res.ok) {
          const errText = await res.text().catch(() => "")
          throw new Error(errText || `Analyze failed with status ${res.status}`)
        }
        const data: AnalyzeResponse = await res.json()
        setResults((prev) => {
          if (runIdRef.current !== runId || signal.aborted) return prev
          const next = [...prev]
          next[i] = data
          return next
        })
      } catch (err) {
        if (signal.aborted) break
        console.error("Upload failed:", err)
        setResults((prev) => {
          if (runIdRef.current !== runId || signal.aborted) return prev
          const next = [...prev]
          next[i] = fallbackResult()
          return next
        })
      }
    }
    if (runIdRef.current !== runId || signal.aborted) return
    abortControllerRef.current = null
    setLoading(false)

    setTimeout(() => {
      const resultsSection = document.getElementById("results-section")
      if (resultsSection) {
        resultsSection.scrollIntoView({ behavior: "smooth" })
      }
    }, 100)
  }
  const documentCount = loading
    ? Math.min(
        uploadedFileNames.length,
        Math.max(1, results.length + 1)
      )
    : Math.max(uploadedFileNames.length, results.length, previewUrlsByFile.length)

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-100 to-blue-50 flex flex-col items-center justify-center px-4 py-10">
      {results.length === 0 && !loading ? (
        <div className="w-full max-w-3xl mx-auto">
          <h1 className="text-4xl font-extrabold text-center mb-4 tracking-tight bg-gradient-to-r from-sky-400 via-blue-500 to-cyan-400 bg-clip-text text-transparent drop-shadow-[0_1px_8px_rgba(59,130,246,0.35)]">
            Meet the Next-Gen Document AI
          </h1>

          <p className="text-center text-lg text-gray-500 mb-8">
            Securely upload your document. DocWise handles the intelligence🚀
          </p>

          <div className="bg-white rounded-3xl shadow-lg p-4 flex flex-row items-center justify-between min-h-[120px]">
      <label
        htmlFor="file-upload-trigger"
        className="flex items-center gap-3 cursor-pointer"
      >
    <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50">
      <svg
        className="w-8 h-8 text-blue-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 4v12m0-12l-4 4m4-4l4 4M4 20h16"
        />
      </svg>
    </span>

    <span className="text-lg text-gray-500">
      PDF, JPEG, PNG, TIFF, ZIP files are supported
    </span>

    <input
      id="file-upload-trigger"
      type="file"
      multiple
      className="hidden"
      disabled={loading}
      onChange={(e) => {
        if (e.target.files && e.target.files.length > 0) {
          handleUpload(e.target.files)
        }
      }}
      accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,.zip"
    />
  </label>

  <button
    className="px-6 py-2 rounded-full border border-gray-200 text-gray-400 bg-gray-100 cursor-not-allowed"
    disabled
  >
    Continue
  </button>
</div>
        </div>
      ) : (
        <div className="w-full max-w-6xl mx-auto space-y-8" id="results-section">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-sky-400 via-blue-500 to-cyan-400 bg-clip-text text-transparent drop-shadow-[0_1px_8px_rgba(59,130,246,0.35)]">
              Next-Gen Document AI
            </h1>

            <button
              onClick={handleBack}
              className="px-4 py-2 rounded-full bg-green-100 text-green-800 border border-green-200 hover:bg-green-200 transition"
            >
              Back
            </button>
          </div>

          {Array.from({ length: documentCount }).map((_, idx) => {
            const result = results[idx]
            const selected = selectedByDoc[idx] ?? null
            const selectedField: FieldType | null =
              selected && result?.fields && result.fields[selected]
                ? result.fields[selected]
                : null
            const previewUrls =
              result?.pages && result.pages.length > 0
                ? result.pages
                : previewUrlsByFile[idx] || []
            const previewMediaTypes =
              result?.pages && result.pages.length > 0
                ? new Array(result.pages.length).fill("image/png")
                : previewMediaTypesByFile[idx] || []
            const summary = result
              ? getSummaryBreakdown(result)
              : { perfect: [], partial: [], failed: [] as Array<{ name: string; reason: string }> }
            const setSelectedForDoc: React.Dispatch<React.SetStateAction<string | null>> = (value) => {
              setSelectedByDoc((prev) => {
                const current = prev[idx] ?? null
                const nextValue =
                  typeof value === "function"
                    ? (value as (prevState: string | null) => string | null)(current)
                    : value
                return { ...prev, [idx]: nextValue }
              })
            }

            return (
              <details key={idx} className="bg-gray-100/40 rounded-2xl p-4" open>
                <summary className="text-xl font-semibold text-gray-800 mb-4 cursor-pointer select-none">
                  {SHOW_FILENAMES_IN_PREVIEW && uploadedFileNames[idx]
                    ? `File ${idx + 1}: ${uploadedFileNames[idx]}`
                    : `File ${idx + 1}`}
                </summary>
                <div
                  className="grid gap-6 mt-3"
                  style={{ gridTemplateColumns: `${PREVIEW_WIDTH_PERCENT}% ${OUTPUT_WIDTH_PERCENT}%` }}
                >
                  <div className="bg-amber-50 border border-amber-200 p-4 rounded-2xl shadow">
                    <h3 className="font-semibold mb-4 text-lg text-amber-900">
                      Document Preview
                    </h3>

                    {previewUrls.length > 0 ? (
                      <DocumentPreview
                        imageUrls={previewUrls}
                        mediaTypes={previewMediaTypes}
                        selectedField={selectedField}
                        caption="Document Preview"
                      />
                    ) : loading ? (
                        <div className="text-amber-700 text-sm">
                          Generating preview...
                        </div>
                      ) : (
                      <div className="text-amber-700 text-sm">
                        No preview available
                      </div>
                    )}
                  </div>

                  <div className="bg-white p-4 rounded-2xl shadow">
                    {loading && !result && (
                      <div className="flex flex-col items-center justify-center py-20">
                        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-600 font-medium">
                          DocWise is analyzing your document...
                        </p>
                      </div>
                    )}

                    {result && (
                      <div className="mb-2">
                    {result.document_type && result.policy_type && (
                      <div className="mb-4 flex flex-col gap-2">
                        <div className="flex gap-6">
                          <span className="font-semibold text-gray-700">
                            Document Type:
                          </span>
                          <div className="relative group">
                            <span className="bg-amber-100 text-amber-800 border border-amber-300 px-3 py-1 rounded-full text-sm font-semibold">
                              {result.document_type}
                            </span>
                            <div className="pointer-events-none absolute z-20 left-0 top-full mt-2 w-80 rounded-md bg-slate-900 text-slate-100 text-xs p-2 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                              {result.document_type_explanation || "Document type explanation unavailable"}
                            </div>
                          </div>

                          <span className="font-semibold text-gray-700">
                            Policy Type:
                          </span>
                          <div className="relative group">
                            <span className="bg-cyan-100 text-cyan-800 border border-cyan-300 px-3 py-1 rounded-full text-sm font-semibold">
                              {result.policy_type}
                            </span>
                            <div className="pointer-events-none absolute z-20 left-0 top-full mt-2 w-80 rounded-md bg-slate-900 text-slate-100 text-xs p-2 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                              {result.policy_type_explanation || "Policy type explanation unavailable"}
                            </div>
                          </div>
                        </div>

                        <details className="mt-2">
                          <summary className="cursor-pointer font-semibold text-gray-600">
                            Expected Fields for this Document
                          </summary>
                          <div className="mt-2 text-sm text-gray-500">
                            {result.expected_fields?.length
                              ? (
                                <ul className="list-disc list-inside space-y-0.5">
                                  {result.expected_fields.map((f, i) => (
                                    <li key={i}>{formatFieldLabel(f)}</li>
                                  ))}
                                </ul>
                              )
                              : "No expected fields found."}
                          </div>
                        </details>
                      </div>
                    )}

                    <div className="mb-3">
                      <span className="inline-flex items-center rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-sm font-semibold text-sky-800">
                        Parsed in {Number(result.processing_time || 0).toFixed(2)}s
                      </span>
                    </div>

                    <Tabs active={activeTab} setActive={setActiveTab} />

                    {activeTab === "fields" && result.fields && (
                      <FieldsPanel
                        fields={result.fields}
                        selected={selected}
                        setSelected={setSelectedForDoc}
                      />
                    )}

                    {activeTab === "form" && result.fields && (
                      <div className="space-y-4">
                        <div className="flex justify-end">
                          <button
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(buildExtractedFieldsClipboardText(result))
                                setCopiedDocIndex(idx)
                                setTimeout(() => setCopiedDocIndex((current) => (current === idx ? null : current)), 1500)
                              } catch (err) {
                                console.error("Copy failed:", err)
                              }
                            }}
                            title={copiedDocIndex === idx ? "Copied" : "Copy to clipboard"}
                            className="w-10 h-10 inline-flex items-center justify-center rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 hover:text-blue-700"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              className="w-5 h-5"
                            >
                              <rect x="9" y="9" width="11" height="11" rx="1.5" />
                              <path d="M5 15V5a1 1 0 0 1 1-1h10" />
                            </svg>
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">
                              Document Type
                            </label>
                            <input
                              readOnly
                              value={result.document_type || ""}
                              className="w-full border rounded px-3 py-2 bg-amber-50 text-amber-900 border-amber-200"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">
                              Policy Type
                            </label>
                            <input
                              readOnly
                              value={result.policy_type || ""}
                              className="w-full border rounded px-3 py-2 bg-cyan-50 text-cyan-900 border-cyan-200"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          {getFormFieldNames(result).map((fieldName) => {
                            const val = result.fields[fieldName]?.value || ""
                            const isLong = /address|remit|reason/i.test(fieldName)
                            const isSelected = selected === fieldName
                            return (
                              <div
                                key={fieldName}
                                className={`${isLong ? "col-span-2" : ""} rounded border p-2 cursor-pointer transition ${
                                  isSelected ? "border-red-400 bg-red-50" : "border-transparent hover:border-blue-200"
                                }`}
                                onClick={() => setSelectedForDoc(selected === fieldName ? null : fieldName)}
                              >
                                <label className="block text-xs font-semibold text-gray-500 mb-1">
                                  {formatFieldLabel(fieldName)}
                                </label>
                                {isLong ? (
                                  <textarea
                                    readOnly
                                    value={val}
                                    rows={2}
                                    className="w-full border rounded px-3 py-2 bg-gray-50 text-gray-800 border-gray-200 resize-none cursor-pointer"
                                  />
                                ) : (
                                  <input
                                    readOnly
                                    value={val}
                                    className="w-full border rounded px-3 py-2 bg-gray-50 text-gray-800 border-gray-200 cursor-pointer"
                                  />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {activeTab === "summary" && result.fields && (
                      <div>
                        <SummaryPanel
                          total={Object.keys(result.fields).length}
                        />

                        {summary && (
                          <div className="mt-6 max-w-[260px]">
                            <Pie
                              data={{
                                labels: [
                                  "Perfect",
                                  "Partial",
                                  "Failed",
                                ],
                                datasets: [
                                  {
                                    data: [
                                      summary.perfect.length,
                                      summary.partial.length,
                                      summary.failed.length,
                                    ],
                                    backgroundColor: [
                                      "#4caf50",
                                      "#ff9800",
                                      "#f44336",
                                    ],
                                  },
                                ],
                              }}
                              options={{
                                maintainAspectRatio: true,
                                plugins: {
                                  legend: {
                                    display: true,
                                    position: "bottom",
                                  },
                                },
                              }}
                            />
                          </div>
                        )}

                        <div className="mt-6 grid grid-cols-3 gap-4">
                          <div className="bg-green-50 rounded p-3">
                            <div className="font-semibold text-green-700 mb-2">
                              Perfect ({summary.perfect.length})
                            </div>
                            <div className="text-sm text-green-800 space-y-1">
                              {summary.perfect.length > 0
                                ? summary.perfect.map((name) => (
                                    <div key={name}>{formatFieldLabel(name)}</div>
                                  ))
                                : <div>None</div>}
                            </div>
                          </div>
                          <div className="bg-yellow-50 rounded p-3">
                            <div className="font-semibold text-yellow-700 mb-2">
                              Partial ({summary.partial.length})
                            </div>
                            <div className="text-sm text-yellow-800 space-y-1">
                              {summary.partial.length > 0
                                ? summary.partial.map((name) => (
                                    <div key={name}>{formatFieldLabel(name)}</div>
                                  ))
                                : <div>None</div>}
                            </div>
                          </div>
                          <div className="bg-red-50 rounded p-3">
                            <div className="font-semibold text-red-700 mb-2">
                              Failed ({summary.failed.length})
                            </div>
                            <div className="text-sm text-red-800 space-y-2">
                              {summary.failed.length > 0
                                ? summary.failed.map((item) => (
                                    <div key={item.name}>
                                      <div>{formatFieldLabel(item.name)}</div>
                                      <div className="text-xs text-red-600">{item.reason}</div>
                                    </div>
                                  ))
                                : <div>None</div>}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {activeTab === "ocr" && result.raw_lines && (
                      <div className="mb-4">
                        <div className="rounded-xl border border-blue-200 bg-white p-4 max-h-[520px] overflow-auto">
                          {(result.raw_lines_by_page && result.raw_lines_by_page.length > 0
                            ? result.raw_lines_by_page
                            : [result.raw_lines]
                          ).map((pageLines, pageIdx) => (
                            <div key={pageIdx} className={pageIdx > 0 ? "mt-6 pt-4 border-t" : ""}>
                              <div className="text-sm font-semibold text-blue-700 mb-2">
                                Page {pageIdx + 1}
                              </div>
                              <div className="space-y-3">
                                {buildTypedOcrBlocks(pageLines).map((item, itemIdx) => (
                                  <div key={`${pageIdx}-${itemIdx}`}>
                                    <div className="text-sm font-medium text-gray-600 mb-1">
                                      {pageIdx + 1}.{itemIdx + 1}. {item.type}
                                    </div>
                                    <pre className="text-[15px] leading-7 whitespace-pre-wrap text-gray-900 font-sans">
                                      {item.content}
                                    </pre>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {activeTab === "json" && (
                      <pre className="text-xs overflow-auto max-h-[500px]">
                        {JSON.stringify(result, null, 2)}
                      </pre>
                    )}
                      </div>
                    )}
                  </div>
                </div>
              </details>
            )
          })}
        </div>
      )}

      {(results.length > 0 || loading) && showBackToTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-6 z-50 rounded-full border-2 border-yellow-500 bg-yellow-400 px-4 py-2 text-sm font-bold text-black shadow-lg hover:bg-yellow-300"
          title="Back to top"
        >
          Top
        </button>
      )}
    </div>
  )
}
