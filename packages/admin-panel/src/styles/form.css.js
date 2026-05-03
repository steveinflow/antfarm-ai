// @docket/admin-panel — CSS extracted from styles.js (lines 201-370)

export const formCss = `/* --- Ticket Form --- */
.tk-form {
  background: var(--tk-bg);
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: var(--tk-shadow);
}

.tk-form-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 16px 0;
}

.tk-form-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.tk-form-group {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.tk-form-group label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--tk-text-secondary);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tk-form-input,
.tk-form-select,
.tk-form-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  font-size: 0.9rem;
  border: 1px solid var(--tk-border);
  border-radius: var(--tk-radius);
  background: var(--tk-bg);
  color: var(--tk-text);
  font-family: var(--tk-font);
  transition: border-color var(--tk-transition);
}

.tk-form-input:focus,
.tk-form-select:focus,
.tk-form-textarea:focus {
  outline: none;
  border-color: var(--tk-primary);
}

.tk-form-input::placeholder,
.tk-form-textarea::placeholder {
  color: var(--tk-text-secondary);
}

.tk-form-textarea {
  min-height: 80px;
  resize: vertical;
}

.tk-form-error {
  color: var(--tk-danger, #e53e3e);
  font-size: 0.85rem;
  margin-top: 4px;
}

.tk-form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

.tk-form-classify-hint {
  font-size: 0.8rem;
  color: var(--tk-text-secondary);
  font-style: italic;
  margin-top: 4px;
}

/* --- Critical flag --- */
.tk-form-critical {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}

.tk-form-critical label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #c53030;
  cursor: pointer;
}

/* --- Screenshot Upload --- */
.tk-screenshot-upload {
  margin-top: 8px;
}

.tk-screenshot-upload-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 0.8rem;
  border: 1px dashed var(--tk-border);
  border-radius: var(--tk-radius);
  cursor: pointer;
  color: var(--tk-text-secondary);
  transition: border-color var(--tk-transition), color var(--tk-transition);
}
.tk-screenshot-upload-label:hover {
  border-color: var(--tk-primary);
  color: var(--tk-primary);
}

.tk-screenshot-upload input[type="file"] {
  display: none;
}

.tk-screenshot-previews {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.tk-screenshot-thumb {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--tk-border);
  cursor: pointer;
}

.tk-screenshot-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tk-screenshot-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  background: var(--tk-danger);
  color: #fff;
  border: none;
  border-radius: 50%;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  cursor: pointer;
  padding: 0;
}
`;
