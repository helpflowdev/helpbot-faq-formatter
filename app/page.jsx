'use client';

import { useState, useRef } from 'react';

const TOTAL_STEPS = 7;

const STAGE_LABELS = [
  'Parsing Excel',
  'Extracting Approved Answers',
  'Generating Stress Test Scenarios',
  'Validating Policy Compliance',
  'Generating Doc-Style Output',
  'Uploading to Google Drive',
  'Sending Slack Notification',
];

const STAGE_MAP = {
  'Extracting Approved Answers':     2,
  'Generating Stress Test Scenarios': 3,
  'Validating Policy Compliance':    4,
  'Generating Doc-Style Output':     5,
  'Uploading to Google Drive':       6,
  'Sending Slack Notification':      7,
};

export default function Home() {
  const [screen, setScreen] = useState('upload');
  const [sessionId, setSessionId] = useState(null);
  const [fileStats, setFileStats] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [processingError, setProcessingError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [stageStates, setStageStates] = useState({});  // { stepNum: 'active' | 'done' }
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(null);

  const fileInputRef = useRef(null);
  const clientCodeRef = useRef(null);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function setStage(step, state) {
    setStageStates(prev => ({ ...prev, [step]: state }));
  }

  function updateProgress(step) {
    setProgress(Math.round((step / TOTAL_STEPS) * 100));
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  async function handleFile(file) {
    setUploadError('');
    setFileStats(null);

    if (!file.name.endsWith('.xlsx')) {
      setUploadError('Invalid file type. Please upload a .xlsx file.');
      return;
    }

    const code = clientCodeRef.current?.value.trim();
    if (!code) {
      setUploadError('Please enter a Client Code before uploading.');
      return;
    }

    setSelectedFile(file);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('client_code', code);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok || data.error) {
        setUploadError(data.error || 'Upload failed.');
        setSelectedFile(null);
        return;
      }

      setSessionId(data.sessionId);
      setFileStats(data);
    } catch {
      setUploadError('Could not reach the server. Please try again.');
      setSelectedFile(null);
    }
  }

  // ── Processing ───────────────────────────────────────────────────────────

  function startProcessing() {
    setScreen('processing');
    setStageStates({ 1: 'done' });
    updateProgress(1);

    const evtSource = new EventSource(`/api/process?session_id=${sessionId}`);

    evtSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.error) {
        evtSource.close();
        setProcessingError(data.error);
        return;
      }

      if (data.stage === 'complete') {
        evtSource.close();
        const allDone = {};
        for (let i = 1; i <= TOTAL_STEPS; i++) allDone[i] = 'done';
        setStageStates(allDone);
        setProgress(100);
        setTimeout(() => {
          setResults(data);
          setScreen('results');
        }, 600);
        return;
      }

      const step = STAGE_MAP[data.stage];
      if (step) {
        setStageStates(prev => {
          const next = { ...prev };
          if (step > 1) next[step - 1] = 'done';
          next[step] = 'active';
          return next;
        });
        updateProgress(step);
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      setProcessingError('Connection lost. Please refresh and try again.');
    };
  }

  // ── Screens ──────────────────────────────────────────────────────────────

  if (screen === 'upload') {
    return (
      <main className="container">
        <div className="card">
          <h1>FAQ Stress Tester</h1>
          <p className="subtitle">Upload your FAQ Excel file to begin processing.</p>

          <div className="field">
            <label htmlFor="client-code">Client Code</label>
            <input
              type="text"
              id="client-code"
              ref={clientCodeRef}
              placeholder="e.g. ACME"
              autoComplete="off"
            />
          </div>

          <div
            className={`drop-zone${dragOver ? ' drag-over' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
          >
            {selectedFile ? selectedFile.name : 'Drag & drop your .xlsx file here\nor click to browse'}
            <input
              type="file"
              ref={fileInputRef}
              accept=".xlsx"
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); }}
            />
          </div>

          {fileStats && (
            <div className="file-stats">
              <div className="stat">
                <span className="stat-label">File</span>
                <span>{fileStats.filename}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Total Rows</span>
                <span>{fileStats.totalRows}</span>
              </div>
              <div className="stat">
                <span className="stat-label">FAQs Detected</span>
                <span>{fileStats.totalFaqs}</span>
              </div>
            </div>
          )}

          {uploadError && <div className="error-msg">{uploadError}</div>}

          {fileStats && (
            <button className="btn-primary" onClick={startProcessing}>
              Start Processing
            </button>
          )}
        </div>
      </main>
    );
  }

  if (screen === 'processing') {
    return (
      <main className="container">
        <div className="card">
          <h2>Processing your FAQs…</h2>

          <div className="progress-wrapper">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="progress-percent">{progress}%</span>
          </div>

          <ul className="stage-list">
            {STAGE_LABELS.map((label, i) => {
              const step = i + 1;
              const state = stageStates[step] || '';
              return (
                <li key={step} className={state}>
                  {label}
                  {state === 'active' && <span className="spinner" />}
                </li>
              );
            })}
          </ul>

          {processingError && <div className="error-msg">{processingError}</div>}
        </div>
      </main>
    );
  }

  // Results screen
  return (
    <main className="container">
      <div className="card">
        <div className="success-badge">Processing Complete</div>

        <div className="summary-grid">
          <div className="summary-item">
            <span className="summary-num">{results?.total ?? '—'}</span>
            <span className="summary-label">Total FAQs</span>
          </div>
          <div className="summary-item">
            <span className="summary-num">{results?.processed ?? '—'}</span>
            <span className="summary-label">Processed</span>
          </div>
          <div className="summary-item">
            <span className="summary-num">{results?.flagged ?? '—'}</span>
            <span className="summary-label">Needs Review</span>
          </div>
        </div>

        <div className="action-buttons">
          <a
            className="btn-primary"
            href={`/api/download/${sessionId}/FAQ_DocStyle_Output.docx`}
            download
          >
            Download Doc Output
          </a>
          <a
            className="btn-secondary"
            href={`/api/download/${sessionId}/FAQ_Needs_Review.xlsx`}
            download
          >
            Download Needs Review
          </a>
          <a
            className="btn-outline"
            href={results?.driveFolderUrl || '#'}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Drive Folder
          </a>
        </div>

        {results?.slackError && (
          <div className="warning-msg">Slack notification failed: {results.slackError}</div>
        )}

        <button className="btn-link" onClick={() => location.reload()}>
          Process another file
        </button>
      </div>
    </main>
  );
}
