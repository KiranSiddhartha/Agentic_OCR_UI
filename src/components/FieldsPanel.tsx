"use client"

import React from "react"

export interface Field {
  value?: string
  bbox?: number[]
  page?: number
  reason?: string
}

interface Props {
  fields: Record<string, Field>
  selected: string | null
  setSelected: React.Dispatch<React.SetStateAction<string | null>>
}

const formatFieldLabel = (name: string) =>
  name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")

export default function FieldsPanel({
  fields,
  selected,
  setSelected,
}: Props) {
  return (
    <div className="space-y-2">
      {Object.entries(fields).map(([key, field]) => (
        (() => {
          const safeField = field ?? {}
          const displayValue =
            typeof safeField.value === "string" && safeField.value.trim()
              ? safeField.value
              : safeField.reason || "Not extracted"
          return (
        <button
          key={key}
          onClick={() =>
            setSelected(selected === key ? null : key)
          }
          className={`w-full text-left p-3 rounded border ${
            selected === key
              ? "bg-red-100 border-red-500"
              : "hover:bg-gray-100"
          }`}
        >
          <div className="font-semibold">
            {formatFieldLabel(key)}
          </div>
          <div className="text-sm text-gray-600">
            {displayValue}
          </div>
        </button>
          )
        })()
      ))}
    </div>
  )
}
