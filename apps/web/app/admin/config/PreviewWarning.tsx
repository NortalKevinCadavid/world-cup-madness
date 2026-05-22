'use client';

import { useState } from 'react';

type PreviewWarningProps = {
  preview: {
    affecting: boolean;
    summary: string;
    sample: unknown;
    acknowledge_token: string | null;
  };
  onConfirm: (token: string | null) => void;
  onCancel: () => void;
};

export default function PreviewWarning({
  preview,
  onConfirm,
  onCancel,
}: PreviewWarningProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  const samplePretty = (() => {
    try {
      return JSON.stringify(preview.sample, null, 2);
    } catch {
      return String(preview.sample);
    }
  })();

  if (!preview.affecting) {
    return (
      <div
        data-testid="config-preview-warning"
        className="rounded-lg border border-green-300 bg-green-50 p-4"
      >
        <div
          data-testid="config-preview-safe"
          className="flex items-start gap-3"
        >
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-green-800">
              Safe to apply
            </h3>
            <p className="mt-1 text-sm text-green-700">
              {preview.summary ||
                'This change does not affect any existing data.'}
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="config-preview-cancel"
            onClick={onCancel}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="config-preview-confirm"
            onClick={() => onConfirm(null)}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            Confirm
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="config-preview-warning"
      className="rounded-lg border border-amber-400 bg-amber-50 p-4"
    >
      <div
        data-testid="config-preview-affecting"
        className="flex items-start gap-3"
      >
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-red-800">
            Warning: this change affects existing data
          </h3>
          <p className="mt-2 text-sm text-amber-900">{preview.summary}</p>

          <details className="mt-3 rounded border border-amber-300 bg-white p-2 text-xs">
            <summary className="cursor-pointer font-medium text-amber-900">
              Sample affected rows
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-gray-800">
              {samplePretty}
            </pre>
          </details>

          <label className="mt-4 flex items-center gap-2 text-sm text-amber-900">
            <input
              type="checkbox"
              data-testid="config-preview-acknowledge"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="h-4 w-4 rounded border-amber-400 text-red-600 focus:ring-red-500"
            />
            <span>I understand the consequences</span>
          </label>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="config-preview-cancel"
          onClick={onCancel}
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="config-preview-confirm"
          disabled={!acknowledged}
          onClick={() => onConfirm(preview.acknowledge_token)}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}
