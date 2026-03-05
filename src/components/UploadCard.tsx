"use client"

import React from "react"

interface Props {
  onUpload: (file: File) => void
  loading: boolean
}

export default function UploadCard({ onUpload, loading }: Props) {
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onUpload(file)
  }

  return (
    <div className="bg-white rounded-xl shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Upload Document</h2>

      <input
        type="file"
        accept=".pdf,.png,.jpg,.jpeg"
        onChange={handleFileChange}
        className="block w-full mb-4"
      />

      {loading && (
        <div className="text-blue-600 font-medium">
          ⏳ Analyzing document...
        </div>
      )}
    </div>
  )
}