'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

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

// Fixed rendering order for category groups (matches PRD §7c / generator.js).
const CATEGORY_ORDER = [
  'Company Details',
  'Ordering and Checkout',
  'Order Status',
  'Stock and Supply Inquiry',
  'Returns, Refunds, Exchanges, and Warranties',
  'Shipping Information',
  'Competitor Comparison',
  'Discounts and Promotions',
  'Rewards and Affiliate Program',
  'Product Information',
  'Product Recommendation',
  'Account and Subscription',
  'Wholesale',
  'Order Cancellation / Modification / Tracking',
  'Do you sell? Do you have?',
  'Services',
  'Installation / Guide',
  'Technical Queries',
  'Miscellaneous',
  'OTHERS',
];

// Needs Review section ordering (matches PRD §11 / generator.js).
const REVIEW_SECTIONS = [
  { key: 'rto', label: 'RTO' },
  { key: 'escalation', label: 'Escalation' },
  { key: 'internal-review', label: 'Internal Review' },
  { key: 'other', label: 'Other' },
];

function groupByCategory(items) {
  const map = new Map();
  for (const item of items || []) {
    const cat = item.category || 'OTHERS';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(item);
  }
  return CATEGORY_ORDER
    .filter(c => map.has(c))
    .map(c => ({ category: c, items: map.get(c) }));
}

function partitionByType(items) {
  const buckets = {};
  for (const item of items || []) {
    const key = item.type || 'other';
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(item);
  }
  return buckets;
}

function splitParagraphs(text) {
  return String(text || '').split('\n\n').map(p => p.trim()).filter(Boolean);
}

export default function Home() {
  const [screen, setScreen] = useState('upload');
  const [sessionId, setSessionId] = useState(null);
  const [fileStats, setFileStats] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [clientCode, setClientCode] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [processingError, setProcessingError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [stageStates, setStageStates] = useState({});
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(null);
  const [copied, setCopied] = useState(false);
  const [dark, setDark] = useState(false);
  const [resultsTab, setResultsTab] = useState('processed');

  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') {
      setDark(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  const fileInputRef = useRef(null);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function setStage(step, state) {
    setStageStates(prev => ({ ...prev, [step]: state }));
  }

  function updateProgress(step) {
    setProgress(Math.round((step / TOTAL_STEPS) * 100));
  }

  // ── Upload (triggered when both file + client code are ready) ───────────

  const tryUpload = useCallback(async (file, code) => {
    if (!file || !code) return;

    setUploadError('');
    setFileStats(null);
    setUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('client_code', code);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok || data.error) {
        setUploadError(data.error || 'Upload failed.');
        setUploading(false);
        return;
      }

      setSessionId(data.sessionId);
      setFileStats(data);
    } catch {
      setUploadError('Could not reach the server. Please try again.');
    } finally {
      setUploading(false);
    }
  }, []);

  function handleFile(file) {
    setUploadError('');
    setFileStats(null);

    const name = file.name.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
      setUploadError('Invalid file type. Please upload a .xlsx or .csv file.');
      return;
    }

    setSelectedFile(file);
    tryUpload(file, clientCode.trim());
  }

  function handleClientCodeChange(value) {
    setClientCode(value);
    const trimmed = value.trim();
    if (trimmed && selectedFile && !fileStats) {
      tryUpload(selectedFile, trimmed);
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

  const themeButton = (
    <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
      {dark ? '\u2600' : '\u263E'}
    </button>
  );

  if (screen === 'upload') {
    return (
      <main className="container">
        {themeButton}
        <div className="card">
          <div className="card-header">
            <h1>FAQ Stress Tester</h1>
            <p className="subtitle">Upload your FAQ Excel file to begin processing.</p>
          </div>

          <div className="upload-fields">
            <div className="field">
              <label htmlFor="client-code">Client Code</label>
              <input
                type="text"
                id="client-code"
                value={clientCode}
                onChange={(e) => handleClientCodeChange(e.target.value)}
                placeholder="e.g. ACME"
                autoComplete="off"
              />
            </div>

            <div
              className={`drop-zone${dragOver ? ' drag-over' : ''}${selectedFile ? ' has-file' : ''}`}
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
              {selectedFile ? (
                <span className="file-name">{selectedFile.name}</span>
              ) : (
                <>
                  <span className="drop-icon">+</span>
                  <span>Drag & drop your .xlsx or .csv file here or click to browse</span>
                </>
              )}
              <input
                type="file"
                ref={fileInputRef}
                accept=".xlsx,.csv"
                style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); }}
              />
            </div>
          </div>

          {uploading && (
            <div className="upload-status">Parsing file...</div>
          )}

          {fileStats && (
            <div className="file-stats">
              <div className="stat">
                <span className="stat-num">{fileStats.totalRows}</span>
                <span className="stat-label">Total Rows</span>
              </div>
              <div className="stat">
                <span className="stat-num">{fileStats.totalFaqs}</span>
                <span className="stat-label">FAQs Detected</span>
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
        {themeButton}
        <div className="card">
          <h2>Processing your FAQs...</h2>

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
    <main className="container container-wide">
      {themeButton}
      <div className="card">
        <div className="success-badge">Processing Complete</div>

        <div className="summary-grid">
          <div className="summary-item">
            <span className="summary-num">{results?.total ?? '—'}</span>
            <span className="summary-label">Total FAQs</span>
          </div>
          <div
            className={`summary-item clickable${resultsTab === 'processed' ? ' active' : ''}`}
            onClick={() => setResultsTab('processed')}
          >
            <span className="summary-num">{results?.processed ?? '—'}</span>
            <span className="summary-label">Processed</span>
          </div>
          <div
            className={`summary-item clickable${resultsTab === 'review' ? ' active' : ''}`}
            onClick={() => setResultsTab('review')}
          >
            <span className="summary-num">{results?.flagged ?? '—'}</span>
            <span className="summary-label">Needs Review</span>
          </div>
        </div>

        {resultsTab === 'processed' && (
          <>
            <div className="action-buttons">
              <a
                className="btn-primary"
                href={`/api/download/${sessionId}/${results?.files?.docx ?? 'FAQ_Formatted.docx'}`}
                download
              >
                Download Doc Output
              </a>
            </div>

            {results?.faqEntries?.length > 0 && (
              <div className="output-preview">
                <div className="output-preview-header">
                  <h3>FAQ Output</h3>
                  <button
                    className="btn-copy"
                    onClick={() => {
                      const el = document.getElementById('faq-editor');
                      if (!el) return;
                      const range = document.createRange();
                      range.selectNodeContents(el);
                      const sel = window.getSelection();
                      sel.removeAllRanges();
                      sel.addRange(range);
                      document.execCommand('copy');
                      sel.removeAllRanges();
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div
                  id="faq-editor"
                  className="output-editor"
                  contentEditable
                  suppressContentEditableWarning
                >
                  {groupByCategory(results.faqEntries).map(({ category, items }) => (
                    <div key={category} className="category-group">
                      <h2 className="category-heading">{category}</h2>
                      {items.map((entry, i) => (
                        <div key={`${category}-${i}`} className="faq-entry">
                          <h1>{entry.title}</h1>
                          {splitParagraphs(entry.answer).map((p, j) => (
                            <p key={j}>{p}</p>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {resultsTab === 'review' && (
          <div className="output-preview">
            <div className="output-preview-header">
              <h3>Items Flagged for Review</h3>
            </div>
            <div className="review-list">
              {results?.needsReviewEntries?.length > 0 ? (
                (() => {
                  const buckets = partitionByType(results.needsReviewEntries);
                  const renderedSections = REVIEW_SECTIONS.filter(s => buckets[s.key]?.length > 0);
                  if (renderedSections.length === 0) {
                    return <div className="review-empty">No items flagged for review.</div>;
                  }
                  return renderedSections.map(({ key, label }) => {
                    const items = buckets[key];
                    return (
                      <section key={key} className="review-section">
                        <h3 className="review-section-heading">
                          NEEDS REVIEW — {label.toUpperCase()} ({items.length})
                        </h3>
                        {groupByCategory(items).map(({ category, items: groupItems }) => (
                          <div key={`${key}-${category}`} className="review-category-group">
                            <h4 className="review-category-heading">{category}</h4>
                            {groupItems.map((item, i) => (
                              <div key={`${key}-${category}-${i}`} className="review-item">
                                <h3 className="review-title">{item.title}</h3>

                                <div className="review-meta-line">
                                  {item.reason && (
                                    <span><strong>Reason:</strong> {item.reason}</span>
                                  )}
                                  {item.status && (
                                    <span><strong>Status:</strong> {item.status}</span>
                                  )}
                                  {item.tags && (
                                    <span><strong>Tags:</strong> {item.tags}</span>
                                  )}
                                  {item.keywords && (
                                    <span><strong>Keywords:</strong> {item.keywords}</span>
                                  )}
                                </div>

                                {item.originalText ? (
                                  <div className="review-block review-original">
                                    <div className="review-block-label">
                                      Original Source ({item.source || 'source'})
                                    </div>
                                    {splitParagraphs(item.originalText).map((p, j) => (
                                      <p key={j}>{p}</p>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="review-block review-original review-original-empty">
                                    <em>(no source text available in this row)</em>
                                  </div>
                                )}

                                {item.internalNote && (
                                  <div className="review-block review-agent-note">
                                    <div className="review-block-label">Agent Note (General guidance)</div>
                                    <p>{item.internalNote}</p>
                                  </div>
                                )}

                                {item.agentProcedure && (
                                  <div className="review-block review-agent-procedure">
                                    <strong>Agent procedure — manual review required.</strong> This content
                                    appears to describe internal tool usage for support agents and cannot
                                    be safely rewritten as customer-facing.
                                  </div>
                                )}

                                {item.generatedAnswer && !item.agentProcedure && (
                                  <div className="review-block review-suggested">
                                    <div className="review-block-label">Suggested Response</div>
                                    {splitParagraphs(item.generatedAnswer).map((p, j) => (
                                      <p key={j}>{p}</p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        ))}
                      </section>
                    );
                  });
                })()
              ) : (
                <div className="review-empty">No items flagged for review.</div>
              )}
            </div>
          </div>
        )}

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
