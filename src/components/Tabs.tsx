"use client"

import React from "react"

interface Props {
  active: string
  setActive: (val: string) => void
}

export default function Tabs({ active, setActive }: Props) {
  const tabs = ["form", "summary", "ocr", "json"]
  const tabLabels: Record<string, string> = {
    form: "Form",
    summary: "Summary",
    ocr: "OCR Output",
    json: "Json",
  }

  return (
    <div className="flex border-b mb-4">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => setActive(tab)}
          className={`px-4 py-2 ${
            active === tab
              ? "border-b-2 border-blue-600 text-blue-600"
              : "text-gray-500"
          }`}
        >
          {tabLabels[tab] || tab}
        </button>
      ))}
    </div>
  )
}
