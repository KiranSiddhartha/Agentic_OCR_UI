"use client"

import React from "react"

interface Props {
  total: number
}

export default function SummaryPanel({ total }: Props) {
  return (
    <div className="bg-gray-50 p-4 rounded">
      <h3 className="font-semibold mb-2">Extraction Summary</h3>
      <div>Total Fields Extracted: {total}</div>
    </div>
  )
}