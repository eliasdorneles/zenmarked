// State
let files = [];
let currentFile = null;
let autoSaveTimeout = null;
let previewTimeout = null;
let images = [];
let widthMode = 'auto'; // 'auto' or 'custom'
let cmEditor = null; // CodeMirror instance
let editMode = false; // true when editing existing image in place
let editPosition = null; // { startLine, endLine } of image being edited
let editIsExternal = false; // true when editing an external URL image
let contextMenuFilename = null; // filename for context menu actions
let linkModalSelection = null; // text selected when Ctrl-K was pressed
let config = {}; // loaded from /api/config
let serverOnline = true;
let heartbeatInterval = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    const savedTheme = localStorage.getItem('zenmarked-theme');
    const theme = config.themeExplicit ? config.theme : (savedTheme || config.theme);
    applyTheme(theme);
    initResizableColumns();
    setupCodeMirror();
    setupDropZone();
    setupPasteHandler();
    setupKeyboardShortcuts();
    setupWidthToggle();
    setupPreviewClickHandler();
    setupGalleryContextMenu();
    await loadFiles();
    await loadImages();

    // Auto-open initial file if specified
    if (config.initialFile) {
        await loadFile(config.initialFile);
    }

    startHeartbeat();
});

// Load config from server
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        config = await response.json();
    } catch (error) {
        console.error('Failed to load config:', error);
        config = { autosave: true, theme: 'dark', initialFile: null, imagePrefix: './images/' };
    }
}

// Apply theme class to body and update CodeMirror theme
function applyTheme(theme) {
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${theme}`);

    if (cmEditor) {
        cmEditor.setOption('theme', theme === 'dark' ? 'dracula' : 'default');
    }

    const toggle = document.getElementById('themeToggle');
    if (toggle) {
        toggle.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    }
}

// Toggle between dark and light, persisting to localStorage
function toggleTheme() {
    const isDark = document.body.classList.contains('theme-dark');
    const newTheme = isDark ? 'light' : 'dark';
    applyTheme(newTheme);
    localStorage.setItem('zenmarked-theme', newTheme);
}

// Setup CodeMirror
function setupCodeMirror() {
    const textarea = document.getElementById('fileBody');
    const isDark = document.body.classList.contains('theme-dark');
    cmEditor = CodeMirror.fromTextArea(textarea, {
        mode: 'markdown',
        lineNumbers: false,
        lineWrapping: true,
        theme: isDark ? 'dracula' : 'default',
        autofocus: false,
        viewportMargin: Infinity,
        extraKeys: {
            'Ctrl-B': wrapBold,
            'Cmd-B': wrapBold,
            'Ctrl-I': wrapItalic,
            'Cmd-I': wrapItalic,
            'Ctrl-E': wrapCode,
            'Cmd-E': wrapCode,
            'Ctrl-K': openLinkModal,
            'Cmd-K': openLinkModal,
            'Shift-Ctrl-7': () => prefixLines('1. '),
            'Shift-Cmd-7': () => prefixLines('1. '),
            'Shift-Ctrl-8': () => prefixLines('- '),
            'Shift-Cmd-8': () => prefixLines('- '),
            'Shift-Ctrl-.': () => prefixLines('> '),
            'Shift-Cmd-.': () => prefixLines('> '),
            'Enter': handleEnter,
        },
    });

    cmEditor.on('change', () => {
        handleBodyInput();
    });

    setupCodeMirrorPasteHandler();
}

// API functions
async function loadFiles() {
    try {
        const response = await fetch('/api/files');
        files = await response.json();
        renderFileList();
    } catch (error) {
        console.error('Failed to load files:', error);
    }
}

async function loadImages() {
    try {
        const response = await fetch('/api/images');
        images = await response.json();
        renderImageGallery();
    } catch (error) {
        console.error('Failed to load images:', error);
    }
}

async function loadFile(filename) {
    try {
        const response = await fetch(`/api/files/${encodeURIComponent(filename)}`);
        if (!response.ok) {
            console.error('Failed to load file:', filename);
            return;
        }
        const data = await response.json();
        currentFile = { filename: data.filename, content: data.content };
        renderEditor();
        updatePreview();

        // Update active state in list
        document.querySelectorAll('.file-item').forEach(el => {
            el.classList.toggle('active', el.dataset.filename === filename);
        });
    } catch (error) {
        console.error('Failed to load file:', error);
    }
}

function startHeartbeat() {
    heartbeatInterval = setInterval(checkServer, 5000);
}

async function checkServer() {
    try {
        await fetch('/api/config');
        onServerOnline();
    } catch {
        onServerOffline();
    }
}

function onServerOffline() {
    if (serverOnline) {
        serverOnline = false;
        showServerDownModal();
    }
}

function onServerOnline() {
    if (!serverOnline) {
        serverOnline = true;
        hideServerDownModal();
        saveFile();
    }
}

function showServerDownModal() {
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    document.getElementById('restartCommand').textContent = `zenmarked --port ${port} --no-browser`;
    document.getElementById('serverDownOverlay').classList.remove('hidden');
}

function hideServerDownModal() {
    document.getElementById('serverDownOverlay').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnContinueEditing').addEventListener('click', hideServerDownModal);
    // btnWaitForServer does nothing — modal stays until server comes back
});

async function saveFile() {
    if (!currentFile) return;
    if (!serverOnline) return;

    setSaveStatus('saving', 'Saving...');

    try {
        const response = await fetch(`/api/files/${encodeURIComponent(currentFile.filename)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: cmEditor.getValue() }),
        });

        if (response.ok) {
            setSaveStatus('saved', 'Saved');
        } else {
            setSaveStatus('error', 'Save failed');
        }
    } catch (error) {
        console.error('Failed to save:', error);
        setSaveStatus('error', 'Save failed');
    }
}

async function createNewFile() {
    if (!serverOnline) {
        showServerDownModal();
        return;
    }
    const filename = prompt('Enter filename:', 'untitled.md');
    if (!filename) return;

    try {
        const response = await fetch('/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
        });

        const data = await response.json();
        if (data.success) {
            await loadFiles();
            await loadFile(data.filename);
        } else {
            alert('Failed to create: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Failed to create file:', error);
    }
}

async function deleteFile() {
    if (!currentFile) return;

    const confirmed = confirm(`Delete "${currentFile.filename}"?\n\nThis action cannot be undone.`);
    if (!confirmed) return;

    try {
        const response = await fetch(`/api/files/${encodeURIComponent(currentFile.filename)}`, {
            method: 'DELETE',
        });

        const data = await response.json();
        if (response.ok && data.success) {
            currentFile = null;
            renderEditor();
            await loadFiles();
        } else {
            alert('Failed to delete: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Failed to delete file:', error);
        alert('Failed to delete file');
    }
}

async function uploadImage(file) {
    const formData = new FormData();
    formData.append('file', file);

    const dropZone = document.getElementById('dropZone');
    const originalText = dropZone.textContent;
    dropZone.innerHTML = 'Uploading... <span class="upload-progress"></span>';

    try {
        const response = await fetch('/api/images', {
            method: 'POST',
            body: formData,
        });

        const data = await response.json();
        dropZone.textContent = originalText;

        if (data.success) {
            await loadImages();
            openImageModal(data.url, data.filename);
        } else {
            alert('Upload failed: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Failed to upload image:', error);
        dropZone.textContent = originalText;
        alert('Failed to upload image');
    }
}

// Rendering functions
function renderFileList() {
    const container = document.getElementById('fileList');
    const search = document.getElementById('searchInput').value.toLowerCase();

    const filtered = files.filter(f =>
        f.filename.toLowerCase().includes(search)
    );

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-list">No files found</div>';
        return;
    }

    container.innerHTML = filtered.map(f => `
        <div class="file-item ${currentFile?.filename === f.filename ? 'active' : ''}"
             data-filename="${escapeHtml(f.filename)}"
             onclick="loadFile('${escapeAttr(f.filename)}')">
            <div class="file-item-name">${escapeHtml(f.filename)}</div>
        </div>
    `).join('');
}

function renderImageGallery() {
    const container = document.getElementById('imageGallery');
    if (images.length === 0) {
        container.innerHTML = '<div class="empty-gallery">No images yet</div>';
        return;
    }
    container.innerHTML = images.slice(0, 12).map(img => `
        <div class="gallery-image"
             onclick="openImageModal('${img.url}', '${img.filename}')"
             oncontextmenu="event.preventDefault(); showContextMenu(event.clientX, event.clientY, '${img.filename}')">
            <img src="${img.url}" alt="${img.filename}" loading="lazy">
        </div>
    `).join('');
}

function renderEditor() {
    if (!currentFile) {
        document.getElementById('editorContent').style.display = 'none';
        document.getElementById('editorEmpty').style.display = 'flex';
        document.getElementById('previewPanel').innerHTML = '<div class="empty-state"><p>Preview will appear here</p></div>';
        updateWindowTitle(null, null);
        return;
    }

    document.getElementById('editorContent').style.display = 'flex';
    document.getElementById('editorEmpty').style.display = 'none';
    document.getElementById('editorFilename').textContent = currentFile.filename;

    cmEditor.setValue(currentFile.content || '');
    setSaveStatus('ready', 'Ready');
}

function updatePreview() {
    const content = cmEditor ? cmEditor.getValue() : '';
    const prefix = config.imagePrefix || './images/';

    // Replace relative image paths with serveable URLs for preview
    let previewContent = content.replace(
        new RegExp(escapeRegex(prefix), 'g'),
        '/static/images/'
    );

    const html = marked.parse(previewContent);
    document.getElementById('previewPanel').innerHTML = `<div class="preview-content">${html}</div>`;
    updateWindowTitle(currentFile ? currentFile.filename : null, content);
}

// UI Helpers
function filterFiles() {
    renderFileList();
}

function setSaveStatus(status, text) {
    const indicator = document.getElementById('saveIndicator');
    const statusEl = document.getElementById('saveStatus');
    indicator.className = 'save-indicator ' + status;
    statusEl.textContent = text;
}

function scheduleAutoSave() {
    clearTimeout(autoSaveTimeout);
    setSaveStatus('pending', 'Unsaved changes...');
    if (config.autosave !== false) {
        autoSaveTimeout = setTimeout(saveFile, 1000);
    }
}

function handleBodyInput() {
    scheduleAutoSave();
    clearTimeout(previewTimeout);
    previewTimeout = setTimeout(updatePreview, 200);
}

function wrapSelection(marker) {
    const sel = cmEditor.getSelection();
    if (sel) {
        cmEditor.replaceSelection(`${marker}${sel}${marker}`);
    } else {
        const cursor = cmEditor.getCursor();
        cmEditor.replaceSelection(`${marker}${marker}`);
        cmEditor.setCursor({ line: cursor.line, ch: cursor.ch + marker.length });
    }
    cmEditor.focus();
    handleBodyInput();
}

function wrapBold() { wrapSelection('**'); }
function wrapItalic() { wrapSelection('*'); }
function wrapCode() { wrapSelection('`'); }

function handleEnter() {
    const cursor = cmEditor.getCursor();
    const line = cmEditor.getLine(cursor.line);

    const ulMatch = line.match(/^(\s*)([-*+] )(.*)/);
    const olMatch = line.match(/^(\s*)(\d+)\. (.*)/);
    const bqMatch = line.match(/^(> )(.*)/);

    if (ulMatch) {
        const [, indent, marker, content] = ulMatch;
        if (!content) {
            cmEditor.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
            cmEditor.replaceSelection('\n');
        } else {
            cmEditor.replaceSelection('\n' + indent + marker);
        }
        handleBodyInput();
        return;
    }

    if (olMatch) {
        const [, indent, num, content] = olMatch;
        if (!content) {
            cmEditor.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
            cmEditor.replaceSelection('\n');
        } else {
            cmEditor.replaceSelection('\n' + indent + (parseInt(num) + 1) + '. ');
        }
        handleBodyInput();
        return;
    }

    if (bqMatch) {
        const [, marker, content] = bqMatch;
        if (!content) {
            cmEditor.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
            cmEditor.replaceSelection('\n');
        } else {
            cmEditor.replaceSelection('\n' + marker);
        }
        handleBodyInput();
        return;
    }

    return CodeMirror.Pass;
}

function prefixLines(prefix) {
    const selections = cmEditor.listSelections();
    const startLine = selections[0].anchor.line < selections[0].head.line
        ? selections[0].anchor.line : selections[0].head.line;
    const endLine = selections[0].anchor.line > selections[0].head.line
        ? selections[0].anchor.line : selections[0].head.line;
    for (let i = startLine; i <= endLine; i++) {
        cmEditor.replaceRange(prefix, { line: i, ch: 0 });
    }
    handleBodyInput();
}

// Link Modal
function openLinkModal() {
    linkModalSelection = cmEditor.getSelection();
    if (linkModalSelection) {
        document.getElementById('linkTextPreview').textContent = linkModalSelection;
        document.getElementById('linkUrl').value = '';
        document.getElementById('linkModal').classList.add('active');
        setTimeout(() => document.getElementById('linkUrl').focus(), 100);
    } else {
        const cursor = cmEditor.getCursor();
        cmEditor.replaceSelection('[](url)');
        cmEditor.setCursor({ line: cursor.line, ch: cursor.ch + 1 });
        cmEditor.focus();
        handleBodyInput();
    }
}

function closeLinkModal() {
    document.getElementById('linkModal').classList.remove('active');
    linkModalSelection = null;
    cmEditor.focus();
}

function submitLink() {
    const url = document.getElementById('linkUrl').value.trim();
    if (!url) return;
    cmEditor.replaceSelection(`[${linkModalSelection}](${url})`);
    closeLinkModal();
    cmEditor.focus();
    handleBodyInput();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDocumentTitle(content) {
    const match = content.match(/^#{1,6}\s+(.+)$/m);
    if (!match) return null;
    // Strip common inline markdown formatting from the heading text
    return match[1]
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // [text](url) → text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // ![alt](url) → (remove images)
        .replace(/(\*\*|__)(.*?)\1/g, '$2')         // **bold** → bold
        .replace(/(\*|_)(.*?)\1/g, '$2')            // *italic* → italic
        .replace(/`([^`]+)`/g, '$1')                // `code` → code
        .trim();
}

function updateWindowTitle(filename, content) {
    const docTitle = content ? extractDocumentTitle(content) : null;
    if (docTitle) {
        document.title = `${docTitle} — zenmarked`;
    } else if (filename) {
        document.title = `${filename} — zenmarked`;
    } else {
        document.title = 'zenmarked';
    }
}

// Drag and Drop
function setupDropZone() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const editorPanel = document.querySelector('.editor-panel');

    dropZone.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false);
    });

    dropZone.addEventListener('drop', handleDrop, false);

    setTimeout(() => {
        const cmWrapper = document.querySelector('.CodeMirror');
        if (cmWrapper) {
            cmWrapper.addEventListener('dragenter', (e) => {
                preventDefaults(e);
                dropZone.classList.add('drag-over');
            });
            cmWrapper.addEventListener('dragover', (e) => {
                preventDefaults(e);
                dropZone.classList.add('drag-over');
            });
            cmWrapper.addEventListener('dragleave', (e) => {
                preventDefaults(e);
                const rect = cmWrapper.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX >= rect.right ||
                    e.clientY < rect.top || e.clientY >= rect.bottom) {
                    dropZone.classList.remove('drag-over');
                }
            });
            cmWrapper.addEventListener('drop', handleDrop, false);
        }
    }, 100);

    editorPanel.addEventListener('dragover', preventDefaults);
    editorPanel.addEventListener('drop', handleDrop, false);

    function handleDrop(e) {
        preventDefaults(e);
        dropZone.classList.remove('drag-over');

        const dt = e.dataTransfer;
        const files = dt.files;

        if (files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
                uploadImage(file);
            } else {
                alert('Please drop an image file (PNG, JPG, GIF, WebP, or SVG)');
            }
        }
    }
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file && file.type.startsWith('image/')) {
        uploadImage(file);
    }
    event.target.value = '';
}

// Paste handler for clipboard images and smart link insertion
function setupPasteHandler() {
    document.addEventListener('paste', (e) => {
        if (!currentFile) return;

        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    const ext = file.type.split('/')[1] || 'png';
                    const timestamp = new Date().toISOString()
                        .replace(/[T:]/g, '-')
                        .replace(/\..+/, '');
                    const newFilename = `pasted-${timestamp}.${ext}`;
                    const renamedFile = new File([file], newFilename, { type: file.type });
                    uploadImage(renamedFile);
                }
                return;
            }
        }
    });
}

function setupCodeMirrorPasteHandler() {
    const cmWrapper = cmEditor.getWrapperElement();
    cmWrapper.addEventListener('paste', (e) => {
        const selection = cmEditor.getSelection();
        if (!selection) return;

        const text = e.clipboardData?.getData('text/plain');
        if (text && isUrl(text)) {
            e.preventDefault();
            e.stopPropagation();
            const link = `[${selection}](${text.trim()})`;
            cmEditor.replaceSelection(link);
            handleBodyInput();
        }
    }, true);
}

function isUrl(str) {
    try {
        const url = new URL(str.trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

// Width toggle
function setupWidthToggle() {
    const autoBtn = document.getElementById('widthAutoBtn');
    const customBtn = document.getElementById('widthCustomBtn');
    const widthInput = document.getElementById('imageWidth');

    autoBtn.addEventListener('click', () => {
        widthMode = 'auto';
        autoBtn.classList.add('active');
        customBtn.classList.remove('active');
        widthInput.disabled = true;
        widthInput.value = '';
    });

    customBtn.addEventListener('click', () => {
        widthMode = 'custom';
        customBtn.classList.add('active');
        autoBtn.classList.remove('active');
        widthInput.disabled = false;
        widthInput.focus();
        if (!widthInput.value) widthInput.value = '400';
    });
}

// Image Modal
function openImageModal(url, filename) {
    document.getElementById('modalImagePreview').src = url;
    document.getElementById('modalImageUrl').value = filename;
    document.getElementById('imageAlt').value = '';
    document.getElementById('imageCaption').value = '';
    document.getElementById('imageWidth').value = '';
    document.getElementById('imageWidth').disabled = true;

    widthMode = 'auto';
    document.getElementById('widthAutoBtn').classList.add('active');
    document.getElementById('widthCustomBtn').classList.remove('active');
    document.querySelector('input[name="alignment"][value="none"]').checked = true;

    document.getElementById('imageModal').classList.add('active');
    setTimeout(() => document.getElementById('imageAlt').focus(), 100);
}

function closeImageModal() {
    document.getElementById('imageModal').classList.remove('active');
    editMode = false;
    editPosition = null;
    editIsExternal = false;
    const insertBtn = document.getElementById('imageModalSubmit');
    if (insertBtn) insertBtn.textContent = 'Insert';
}

function insertImage() {
    const filename = document.getElementById('modalImageUrl').value;
    const alt = document.getElementById('imageAlt').value || filename;
    const caption = document.getElementById('imageCaption').value;
    const alignment = document.querySelector('input[name="alignment"]:checked').value;
    const width = widthMode === 'custom' ? document.getElementById('imageWidth').value : null;

    const prefix = config.imagePrefix || './images/';
    const imgPath = editIsExternal ? filename : `${prefix}${filename}`;

    let code = '';
    if (caption) {
        const alignClass = alignment !== 'none' ? ` align-${alignment}` : '';
        const styleAttr = width ? ` style="width: ${width}px"` : '';
        code = `<div class="figure${alignClass}"${styleAttr}>
  <img src="${imgPath}" alt="${alt}">
  <p class="caption">${caption}</p>
</div>`;
    } else if (alignment !== 'none' || width) {
        const alignClass = alignment !== 'none' ? ` class="align-${alignment}"` : '';
        const widthAttr = width ? ` width="${width}"` : '';
        code = `<img src="${imgPath}"${alignClass}${widthAttr} alt="${alt}" />`;
    } else {
        code = `![${alt}](${imgPath})`;
    }

    if (editMode && editPosition) {
        const endLineContent = cmEditor.getLine(editPosition.endLine);
        cmEditor.replaceRange(
            code,
            { line: editPosition.startLine, ch: 0 },
            { line: editPosition.endLine, ch: endLineContent.length }
        );
        editMode = false;
        editPosition = null;
        editIsExternal = false;
    } else {
        const cursor = cmEditor.getCursor();
        const line = cmEditor.getLine(cursor.line);
        let prefix_nl = '';
        let suffix_nl = '\n\n';
        if (cursor.ch > 0 || line.length > 0) {
            prefix_nl = '\n\n';
        }
        cmEditor.replaceSelection(prefix_nl + code + suffix_nl);
    }

    cmEditor.focus();
    closeImageModal();
    handleBodyInput();
}

// Keyboard shortcuts
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (currentFile) {
                clearTimeout(autoSaveTimeout);
                saveFile();
            }
        }

        if (e.altKey && e.key === 'n') {
            e.preventDefault();
            createNewFile();
        }

        if (e.key === 'Escape') {
            closeImageModal();
            closeRenameModal();
            closeLinkModal();
        }

        if (e.key === 'Enter' && document.getElementById('imageModal').classList.contains('active')) {
            if (document.activeElement.tagName !== 'INPUT') {
                e.preventDefault();
                insertImage();
            }
        }

        if (e.key === 'Enter' && document.getElementById('renameModal').classList.contains('active')) {
            e.preventDefault();
            submitRename();
        }

        if (e.key === 'Enter' && document.getElementById('linkModal').classList.contains('active')) {
            e.preventDefault();
            submitLink();
        }
    });
}

// Preview click-to-edit
function setupPreviewClickHandler() {
    const preview = document.getElementById('previewPanel');
    preview.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG') {
            handlePreviewImageClick(e.target);
        }
    });
}

function handlePreviewImageClick(imgElement) {
    const src = imgElement.getAttribute('src');
    const isExternal = src.startsWith('http://') || src.startsWith('https://');
    const filename = isExternal ? src : src.replace('/static/images/', '');

    const figure = imgElement.closest('.figure');
    const info = {
        filename: filename,
        alt: imgElement.getAttribute('alt') || '',
        caption: figure ? (figure.querySelector('.caption')?.textContent || '') : '',
        alignment: extractAlignment(figure || imgElement),
        width: extractWidth(figure || imgElement),
        isExternal: isExternal,
    };

    const sourcePosition = isExternal ? findExternalImageInSource(filename) : findImageInSource(filename);
    if (sourcePosition) {
        openImageModalForEdit(info, sourcePosition);
    }
}

function extractAlignment(element) {
    const classList = element.classList;
    if (classList.contains('align-left')) return 'left';
    if (classList.contains('align-right')) return 'right';
    if (classList.contains('align-center')) return 'center';
    return 'none';
}

function extractWidth(element) {
    const style = element.getAttribute('style');
    if (style) {
        const match = style.match(/width:\s*(\d+)px/);
        if (match) return match[1];
    }
    const widthAttr = element.getAttribute('width');
    if (widthAttr) return widthAttr;
    return null;
}

function findImageInSource(filename) {
    const content = cmEditor.getValue();
    const lines = content.split('\n');
    const prefix = config.imagePrefix || './images/';
    const escapedFilename = escapeRegex(filename);
    const escapedPrefix = escapeRegex(prefix);

    const markdownPattern = new RegExp(`!\\[[^\\]]*\\]\\(${escapedPrefix}${escapedFilename}\\)`);
    const imgPattern = new RegExp(`<img[^>]*src=["']${escapedPrefix}${escapedFilename}["'][^>]*/?>`, 'i');
    const figureStartPattern = /<div\s+class=["']figure[^"']*["']/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (markdownPattern.test(line)) {
            return { startLine: i, endLine: i };
        }

        if (imgPattern.test(line) && !figureStartPattern.test(line)) {
            return { startLine: i, endLine: i };
        }

        if (figureStartPattern.test(line)) {
            let endLine = i;
            let blockContent = line;
            for (let j = i; j < lines.length; j++) {
                blockContent += '\n' + lines[j];
                if (lines[j].includes('</div>')) {
                    endLine = j;
                    break;
                }
            }
            if (blockContent.includes(`${prefix}${filename}`)) {
                return { startLine: i, endLine: endLine };
            }
        }
    }
    return null;
}

function findExternalImageInSource(url) {
    const content = cmEditor.getValue();
    const lines = content.split('\n');
    const escapedUrl = escapeRegex(url);
    const markdownPattern = new RegExp(`!\\[[^\\]]*\\]\\(${escapedUrl}\\)`);
    const imgPattern = new RegExp(`<img[^>]*src=["']${escapedUrl}["'][^>]*/?>`, 'i');
    const figureStartPattern = /<div\s+class=["']figure[^"']*["']/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (markdownPattern.test(line)) return { startLine: i, endLine: i };
        if (imgPattern.test(line) && !figureStartPattern.test(line)) return { startLine: i, endLine: i };

        if (figureStartPattern.test(line)) {
            let endLine = i;
            let blockContent = line;
            for (let j = i; j < lines.length; j++) {
                blockContent += '\n' + lines[j];
                if (lines[j].includes('</div>')) { endLine = j; break; }
            }
            if (blockContent.includes(url)) return { startLine: i, endLine: endLine };
        }
    }
    return null;
}

function openImageModalForEdit(info, position) {
    editMode = true;
    editPosition = position;
    editIsExternal = info.isExternal || false;

    const previewSrc = info.isExternal ? info.filename : `/static/images/${info.filename}`;
    document.getElementById('modalImagePreview').src = previewSrc;
    document.getElementById('modalImageUrl').value = info.filename;
    document.getElementById('imageAlt').value = info.alt;
    document.getElementById('imageCaption').value = info.caption;
    document.querySelector(`input[name="alignment"][value="${info.alignment}"]`).checked = true;

    if (info.width) {
        widthMode = 'custom';
        document.getElementById('widthAutoBtn').classList.remove('active');
        document.getElementById('widthCustomBtn').classList.add('active');
        document.getElementById('imageWidth').value = info.width;
        document.getElementById('imageWidth').disabled = false;
    } else {
        widthMode = 'auto';
        document.getElementById('widthAutoBtn').classList.add('active');
        document.getElementById('widthCustomBtn').classList.remove('active');
        document.getElementById('imageWidth').value = '';
        document.getElementById('imageWidth').disabled = true;
    }

    const insertBtn = document.getElementById('imageModalSubmit');
    if (insertBtn) insertBtn.textContent = 'Update';

    document.getElementById('imageModal').classList.add('active');
    setTimeout(() => document.getElementById('imageAlt').focus(), 100);
}

// Gallery Context Menu
function setupGalleryContextMenu() {
    const contextMenu = document.getElementById('galleryContextMenu');
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) hideContextMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideContextMenu();
    });
}

function showContextMenu(x, y, filename) {
    const contextMenu = document.getElementById('galleryContextMenu');
    contextMenuFilename = filename;
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.add('active');

    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        contextMenu.style.left = `${window.innerWidth - rect.width - 5}px`;
    }
    if (rect.bottom > window.innerHeight) {
        contextMenu.style.top = `${window.innerHeight - rect.height - 5}px`;
    }
}

function hideContextMenu() {
    document.getElementById('galleryContextMenu').classList.remove('active');
    contextMenuFilename = null;
}

// Rename Modal
async function openRenameModal(filename) {
    hideContextMenu();
    if (!filename) return;

    const modal = document.getElementById('renameModal');
    const preview = document.getElementById('renameModalPreview');
    const currentName = document.getElementById('renameCurrentName');
    const newNameInput = document.getElementById('renameNewName');
    const extensionSpan = document.getElementById('renameExtension');
    const affectedFiles = document.getElementById('affectedFiles');

    preview.src = `/static/images/${filename}`;
    currentName.textContent = filename;

    const lastDot = filename.lastIndexOf('.');
    const baseName = lastDot > 0 ? filename.substring(0, lastDot) : filename;
    const extension = lastDot > 0 ? filename.substring(lastDot) : '';
    newNameInput.value = baseName;
    extensionSpan.textContent = extension;

    affectedFiles.innerHTML = '<div class="loading">Loading...</div>';
    modal.classList.add('active');
    setTimeout(() => newNameInput.focus(), 100);

    try {
        const response = await fetch(`/api/images/${encodeURIComponent(filename)}/references`);
        const data = await response.json();

        if (data.files && data.files.length > 0) {
            affectedFiles.innerHTML = data.files.map(f => `
                <div class="affected-post-item">
                    <span class="post-title">${escapeHtml(f.filename)}</span>
                    <span class="ref-count">(${f.ref_count} ref${f.ref_count > 1 ? 's' : ''})</span>
                </div>
            `).join('');
        } else {
            affectedFiles.innerHTML = '<div class="no-refs">No files reference this image</div>';
        }
    } catch (error) {
        console.error('Failed to fetch references:', error);
        affectedFiles.innerHTML = '<div class="no-refs">Failed to load references</div>';
    }
}

function closeRenameModal() {
    document.getElementById('renameModal').classList.remove('active');
}

async function submitRename() {
    const currentName = document.getElementById('renameCurrentName').textContent;
    const newName = document.getElementById('renameNewName').value.trim();

    if (!newName) {
        alert('Please enter a new name');
        return;
    }

    const submitBtn = document.getElementById('renameSubmitBtn');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Renaming...';
    submitBtn.disabled = true;

    try {
        const response = await fetch(`/api/images/${encodeURIComponent(currentName)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_name: newName }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
            closeRenameModal();
            await loadImages();

            // Reload current file if it was affected
            if (currentFile && data.updated_files) {
                const wasUpdated = data.updated_files.some(f => f.filename === currentFile.filename);
                if (wasUpdated) {
                    await loadFile(currentFile.filename);
                }
            }
        } else {
            alert('Rename failed: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Failed to rename:', error);
        alert('Failed to rename image');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}

// Resizable columns
function initResizableColumns() {
    const container = document.querySelector('.container');
    const handle1 = document.getElementById('resizeHandle1'); // sidebar | editor
    const handle2 = document.getElementById('resizeHandle2'); // editor | preview
    const sidebar = document.querySelector('.sidebar');
    const editorPanel = document.querySelector('.editor-panel');

    const STORAGE_KEY = 'zenmarked-col-widths';
    const MIN_SIDEBAR = 160;
    const MIN_EDITOR = 200;
    const MIN_PREVIEW = 200;
    const HANDLE_TOTAL = 8; // two 4px handles

    function available() {
        return container.getBoundingClientRect().width - HANDLE_TOTAL;
    }

    // All three columns are fr units so they scale proportionally on window resize.
    // sidebarRatio + editorRatio + previewRatio = 1
    function applyRatios(sidebarRatio, editorRatio) {
        const previewRatio = 1 - sidebarRatio - editorRatio;
        container.style.gridTemplateColumns =
            `${sidebarRatio}fr 4px ${editorRatio}fr 4px ${previewRatio}fr`;
    }

    const saved = (() => {
        try {
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (s && s.sidebarRatio && s.editorRatio) return s;
        } catch {}
        return null;
    })();

    if (saved) {
        applyRatios(saved.sidebarRatio, saved.editorRatio);
    } else {
        const avail = available();
        const sidebarRatio = 260 / avail;
        const editorRatio = (1 - sidebarRatio) / 2;
        applyRatios(sidebarRatio, editorRatio);
    }

    function makeResizable(handle, computeNewPx) {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            document.body.classList.add('resizing');
            handle.classList.add('dragging');
            const startX = e.clientX;
            const startSidebarPx = sidebar.getBoundingClientRect().width;
            const startEditorPx = editorPanel.getBoundingClientRect().width;

            function onMove(e) {
                const dx = e.clientX - startX;
                const avail = available();
                const { sidebarPx, editorPx } = computeNewPx(dx, startSidebarPx, startEditorPx, avail);
                applyRatios(sidebarPx / avail, editorPx / avail);
            }

            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.classList.remove('resizing');
                handle.classList.remove('dragging');
                const avail = available();
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    sidebarRatio: sidebar.getBoundingClientRect().width / avail,
                    editorRatio: editorPanel.getBoundingClientRect().width / avail,
                }));
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // Handle 1: drag moves sidebar/editor boundary — sidebar grows/shrinks, preview absorbs the rest
    makeResizable(handle1, (dx, startSidebarPx, startEditorPx, avail) => ({
        sidebarPx: Math.max(MIN_SIDEBAR, Math.min(startSidebarPx + dx, avail - startEditorPx - MIN_PREVIEW)),
        editorPx: startEditorPx,
    }));

    // Handle 2: drag moves editor/preview boundary — editor grows/shrinks
    makeResizable(handle2, (dx, startSidebarPx, startEditorPx, avail) => ({
        sidebarPx: startSidebarPx,
        editorPx: Math.max(MIN_EDITOR, Math.min(startEditorPx + dx, avail - startSidebarPx - MIN_PREVIEW)),
    }));
}
