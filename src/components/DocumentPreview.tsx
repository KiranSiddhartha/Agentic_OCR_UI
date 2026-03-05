"use client"

import React, { useEffect, useRef, useState } from "react"

import type { Field } from "./FieldsPanel";

interface Props {
  imageUrls: string[];
  selectedField: Field | null;
  caption?: string;
  mediaTypes?: string[];
}

export default function DocumentPreview({
  imageUrls,
  selectedField,
  caption,
  mediaTypes,
}: Props) {
  const [pageCursor, setPageCursor] = useState(0)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  let selectedPage: number | null = null
  const rawPage = selectedField?.page
  const parsedPage =
    typeof rawPage === "number"
      ? rawPage
      : typeof rawPage === "string"
      ? Number(rawPage)
      : NaN
  if (Number.isFinite(parsedPage) && imageUrls.length > 0) {
    selectedPage = parsedPage
    if (selectedPage >= imageUrls.length && selectedPage - 1 >= 0) {
      selectedPage = selectedPage - 1
    }
    selectedPage = Math.max(0, Math.min(selectedPage, imageUrls.length - 1))
  }
  const currentPage = Math.max(0, Math.min(pageCursor, Math.max(0, imageUrls.length - 1)))
  const currentUrl = imageUrls[currentPage]
  const currentMediaType = mediaTypes?.[currentPage]?.toLowerCase() || ""
  const isPdf =
    currentMediaType === "application/pdf" || /\.pdf(\?|$)/i.test(currentUrl || "")
  const showImage = Boolean(currentUrl) && !isPdf
  const imageFailed = failedUrl === currentUrl
  const imageReady = loadedUrl === currentUrl && showImage && !imageFailed

  useEffect(() => {
    if (selectedPage === null) return
    setPageCursor(selectedPage)
  }, [selectedPage])

  useEffect(() => {
    if (imageUrls.length === 0) {
      setPageCursor(0)
      return
    }
    setPageCursor((p) => Math.max(0, Math.min(p, imageUrls.length - 1)))
  }, [imageUrls.length])

  useEffect(() => {
    if (!selectedField?.bbox || !imageReady) {
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext("2d")
        if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      }
      return
    }
    if (!imgRef.current || !canvasRef.current) return
    const img = imgRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    canvas.width = img.clientWidth
    canvas.height = img.clientHeight
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const coords = selectedField.bbox.map((n) => Number(n))
    if (coords.length !== 4 || coords.some((n) => Number.isNaN(n))) return
    const [bx1, by1, bx2, by2] = coords
    if (!img.naturalWidth || !img.naturalHeight) return
    let x1 = bx1
    let y1 = by1
    let x2 = bx2
    let y2 = by2

    // Match bbox handling from app.py: normalized (0..1), layout-scaled (0..1000), or pixel coords.
    if ([x1, y1, x2, y2].every((c) => c >= 0 && c <= 1)) {
      x1 = x1 * img.naturalWidth
      x2 = x2 * img.naturalWidth
      y1 = y1 * img.naturalHeight
      y2 = y2 * img.naturalHeight
    } else if ([x1, y1, x2, y2].every((c) => c >= 0 && c <= 1000)) {
      x1 = (x1 / 1000) * img.naturalWidth
      x2 = (x2 / 1000) * img.naturalWidth
      y1 = (y1 / 1000) * img.naturalHeight
      y2 = (y2 / 1000) * img.naturalHeight
    }

    if (x2 < x1) [x1, x2] = [x2, x1]
    if (y2 < y1) [y1, y2] = [y2, y1]

    const scaleX = img.clientWidth / img.naturalWidth
    const scaleY = img.clientHeight / img.naturalHeight
    ctx.strokeStyle = "red"
    ctx.lineWidth = 3
    ctx.strokeRect(
      x1 * scaleX,
      y1 * scaleY,
      (x2 - x1) * scaleX,
      (y2 - y1) * scaleY
    )
  }, [selectedField, currentPage, imageUrls, imageReady])

  const handlePrev = () => {
    setFailedUrl(null)
    setLoadedUrl(null)
    setPageCursor((p) => Math.max(0, p - 1))
  }
  const handleNext = () => {
    setFailedUrl(null)
    setLoadedUrl(null)
    setPageCursor((p) => Math.min(imageUrls.length - 1, p + 1))
  }

  return (
    <div className="relative">
      <img
        ref={imgRef}
        src={currentUrl}
        alt="preview"
        className={`w-full ${showImage && !imageFailed ? "block" : "hidden"}`}
        onLoad={() => setLoadedUrl(currentUrl || null)}
        onError={() => {
          setLoadedUrl(null)
          setFailedUrl(currentUrl || null)
        }}
      />
      {isPdf && currentUrl && (
        <div className="space-y-2">
          <iframe
            src={currentUrl}
            title="PDF preview"
            className="w-full h-[420px] rounded border border-gray-100"
          />
          <a
            href={currentUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 hover:underline"
          >
            Open PDF in a new tab
          </a>
        </div>
      )}
      {!isPdf && imageFailed && (
        <div className="text-sm text-gray-500">
          Preview unavailable for this file type.
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`absolute top-0 left-0 ${showImage && !imageFailed ? "block" : "hidden"}`}
      />
      <div className="flex justify-between items-center mt-2">
        <button
          onClick={handlePrev}
          disabled={currentPage === 0}
          className="px-3 py-1 bg-gray-200 rounded disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-sm">Page {currentPage + 1} of {imageUrls.length}</span>
        <button
          onClick={handleNext}
          disabled={currentPage === imageUrls.length - 1}
          className="px-3 py-1 bg-gray-200 rounded disabled:opacity-50"
        >
          Next
        </button>
      </div>
      {caption && <div className="text-gray-500 text-sm mt-2">{caption}</div>}
    </div>
  )
}
