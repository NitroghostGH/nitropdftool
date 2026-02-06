/**
 * Canvas Editor for PDF Alignment and Asset Overlay
 * Uses Fabric.js for canvas manipulation
 */

// Get CSRF token from cookies (required for Django)
function getCSRFToken() {
    const name = 'csrftoken';
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}

// State
let canvas = null;
let currentMode = 'pan';
let selectedSheet = null;
let selectedAsset = null;
let sheets = [];
let assets = [];
let calibrationPoints = [];

// Crop/Cut tool state
let cropRect = null;
let cropStart = null;
let isCropping = false;
let sheetCutData = {};  // Store cut data per sheet for flipping

// Viewport rotation state
let viewportRotation = 0;  // Will be loaded from PROJECT_DATA

// Undo system
const undoStack = [];
const MAX_UNDO_STEPS = 50;

/**
 * Save state for undo functionality
 * @param {string} actionType - Type of action: 'move', 'rotate', 'cut', 'clearCut'
 * @param {object} data - State data to save
 */
function saveUndoState(actionType, data) {
    undoStack.push({
        type: actionType,
        timestamp: Date.now(),
        data: JSON.parse(JSON.stringify(data))  // Deep clone
    });

    // Limit stack size
    if (undoStack.length > MAX_UNDO_STEPS) {
        undoStack.shift();
    }

    console.log('Undo state saved:', actionType, data);
}

/**
 * Undo the last action
 */
async function undo() {
    if (undoStack.length === 0) {
        console.log('Nothing to undo');
        return;
    }

    const lastAction = undoStack.pop();
    console.log('Undoing action:', lastAction.type, lastAction.data);

    switch (lastAction.type) {
        case 'transform':
            await undoTransform(lastAction.data);
            break;
        case 'cut':
            await undoCut(lastAction.data);
            break;
        case 'clearCut':
            await undoClearCut(lastAction.data);
            break;
    }
}

/**
 * Undo a sheet transform action (combined move + rotate)
 */
async function undoTransform(data) {
    const { sheetId, previousX, previousY, previousRotation } = data;

    // Find sheet object on canvas
    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        // Restore canvas position and rotation
        sheetObj.set({
            left: previousX,
            top: previousY,
            angle: previousRotation
        });
        sheetObj.setCoords();
        canvas.renderAll();

        // Update local data
        const index = sheets.findIndex(s => s.id === sheetId);
        if (index >= 0) {
            sheets[index].offset_x = previousX;
            sheets[index].offset_y = previousY;
            sheets[index].rotation = previousRotation;
        }

        // Update properties panel if selected
        if (selectedSheet && selectedSheet.id === sheetId) {
            document.getElementById('sheet-offset-x').value = previousX;
            document.getElementById('sheet-offset-y').value = previousY;
            document.getElementById('sheet-rotation').value = previousRotation.toFixed(1);
            selectedSheet.offset_x = previousX;
            selectedSheet.offset_y = previousY;
            selectedSheet.rotation = previousRotation;
        }

        // Save to server (both position and rotation)
        await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                offset_x: previousX,
                offset_y: previousY,
                rotation: previousRotation
            })
        });
    }
}

/**
 * Undo a cut action (remove the cut)
 */
async function undoCut(data) {
    const { sheetId, previousCutData } = data;

    // Find sheet object on canvas
    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        // If there was a previous cut, restore it; otherwise clear
        if (previousCutData) {
            sheetCutData[sheetId] = previousCutData;
            applyCutMaskWithDirection(sheetObj, previousCutData.p1, previousCutData.p2, previousCutData.flipped);
        } else {
            // No previous cut - clear the clip path
            sheetObj.clipPath = null;
            delete sheetCutData[sheetId];
            canvas.renderAll();
        }

        // Save to server
        if (previousCutData) {
            await saveCutData(sheetId, previousCutData);
        } else {
            await fetch(`/api/sheets/${sheetId}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCSRFToken()
                },
                body: JSON.stringify({
                    crop_x: 0,
                    crop_y: 0,
                    crop_width: 0,
                    crop_height: 0
                })
            });
        }
    }
}

/**
 * Undo a clear cut action (restore the cut)
 */
async function undoClearCut(data) {
    const { sheetId, cutData } = data;

    if (!cutData) return;

    // Find sheet object on canvas
    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        // Restore the cut
        sheetCutData[sheetId] = cutData;
        applyCutMaskWithDirection(sheetObj, cutData.p1, cutData.p2, cutData.flipped);

        // Save to server
        await saveCutData(sheetId, cutData);
    }
}

// Initialize canvas
document.addEventListener('DOMContentLoaded', function() {
    initCanvas();
    loadProjectData();

    // Initialize viewport rotation from project data
    if (PROJECT_DATA.canvas_rotation) {
        viewportRotation = PROJECT_DATA.canvas_rotation;
        // Apply rotation after canvas is ready
        setTimeout(() => {
            applyViewportRotation();
            updateRotationDisplay();
        }, 100);
    }
});

function initCanvas() {
    const container = document.getElementById('canvas-container');
    const containerRect = container.getBoundingClientRect();

    // Create canvas element
    const canvasEl = document.createElement('canvas');
    canvasEl.id = 'main-canvas';
    container.appendChild(canvasEl);

    // Initialize Fabric canvas
    canvas = new fabric.Canvas('main-canvas', {
        width: containerRect.width,
        height: containerRect.height,
        backgroundColor: '#e0e0e0',
        selection: false
    });

    // Setup event handlers
    setupCanvasEvents();
    setupKeyboardShortcuts();

    // Handle window resize
    window.addEventListener('resize', function() {
        const rect = container.getBoundingClientRect();
        canvas.setDimensions({ width: rect.width, height: rect.height });
        canvas.renderAll();
    });
}

function setupCanvasEvents() {
    let isPanning = false;
    let lastPosX, lastPosY;

    // Track initial state for undo when interaction starts
    let interactionStartState = null;

    canvas.on('mouse:down', function(opt) {
        const evt = opt.e;
        console.log('mouse:down event, currentMode:', currentMode);

        // Capture state at the beginning of a transformation for undo
        const target = opt.target;
        if (target && target.sheetData && currentMode === 'select') {
            interactionStartState = {
                sheetId: target.sheetData.id,
                left: target.left,
                top: target.top,
                angle: target.angle
            };
        }

        if (currentMode === 'pan') {
            isPanning = true;
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            canvas.defaultCursor = 'grabbing';
        } else if (currentMode === 'calibrate') {
            handleCalibrationClick(opt);
        } else if (currentMode === 'origin') {
            handleOriginClick(opt);
        } else if (currentMode === 'select') {
            handleSelectClick(opt);
        } else if (currentMode === 'crop') {
            handleCropClick(opt);
        } else if (currentMode === 'split') {
            handleSplitClick(opt);
        }
    });

    canvas.on('mouse:move', function(opt) {
        updateCursorPosition(opt);

        if (isPanning && currentMode === 'pan') {
            const evt = opt.e;
            const vpt = canvas.viewportTransform;
            vpt[4] += evt.clientX - lastPosX;
            vpt[5] += evt.clientY - lastPosY;
            canvas.requestRenderAll();
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
        }

        // Handle crop drag
        if (currentMode === 'crop') {
            handleCropMove(opt);
        }

        // Handle split drag (same visual as crop)
        if (currentMode === 'split') {
            handleSplitMove(opt);
        }
    });

    canvas.on('mouse:up', function(opt) {
        isPanning = false;
        if (currentMode === 'pan') {
            canvas.defaultCursor = 'grab';
        }

        // Handle crop end
        if (currentMode === 'crop' && isCropping) {
            handleCropEnd(opt);
        }

        // Handle split end
        if (currentMode === 'split' && isSplitting) {
            handleSplitEnd(opt);
        }
    });

    canvas.on('mouse:wheel', function(opt) {
        const delta = opt.e.deltaY;
        let zoom = canvas.getZoom();
        zoom *= 0.999 ** delta;
        if (zoom > 5) zoom = 5;
        if (zoom < 0.1) zoom = 0.1;

        // Zoom to point while preserving rotation
        const point = { x: opt.e.offsetX, y: opt.e.offsetY };
        const vpt = canvas.viewportTransform.slice();

        // Calculate the point in canvas coordinates before zoom
        const beforeX = (point.x - vpt[4]) / canvas.getZoom();
        const beforeY = (point.y - vpt[5]) / canvas.getZoom();

        // Apply new zoom with rotation
        const angleRad = viewportRotation * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);

        vpt[0] = cos * zoom;
        vpt[1] = sin * zoom;
        vpt[2] = -sin * zoom;
        vpt[3] = cos * zoom;

        // Adjust pan to keep the zoom point stationary
        vpt[4] = point.x - beforeX * zoom;
        vpt[5] = point.y - beforeY * zoom;

        canvas.setViewportTransform(vpt);
        opt.e.preventDefault();
        opt.e.stopPropagation();

        updateZoomDisplay();
    });

    canvas.on('object:moving', function(opt) {
        const obj = opt.target;
        if (obj.assetData) {
            // Asset is being dragged
            updateAssetPositionFromCanvas(obj);
        } else if (obj.sheetData) {
            // Sheet is being dragged
            updateSheetPositionFromCanvas(obj);
        }
    });

    // Use object:modified which fires after any transformation (move, rotate, scale)
    canvas.on('object:modified', function(opt) {
        const obj = opt.target;
        if (obj.sheetData) {
            // Save undo state for the transformation (single combined state)
            if (interactionStartState && interactionStartState.sheetId === obj.sheetData.id) {
                const positionChanged = interactionStartState.left !== obj.left || interactionStartState.top !== obj.top;
                const rotationChanged = interactionStartState.angle !== obj.angle;

                // Save a single combined transform state if anything changed
                if (positionChanged || rotationChanged) {
                    saveUndoState('transform', {
                        sheetId: obj.sheetData.id,
                        previousX: interactionStartState.left,
                        previousY: interactionStartState.top,
                        previousRotation: interactionStartState.angle
                    });
                }
                // Clear the interaction state
                interactionStartState = null;
            }

            // Check if rotation changed and update
            updateSheetRotationFromCanvas(obj);
            // Also save position in case it was moved
            updateSheetPositionFromCanvas(obj);
        }
    });

    // Also update during rotation for live feedback in properties panel
    canvas.on('object:rotating', function(opt) {
        const obj = opt.target;
        if (obj.sheetData && selectedSheet && selectedSheet.id === obj.sheetData.id) {
            // Live update the rotation field while rotating
            document.getElementById('sheet-rotation').value = obj.angle.toFixed(1);
        }
    });

    // Sync selection when user clicks on an object
    canvas.on('selection:created', function(opt) {
        const obj = opt.selected[0];
        if (obj && obj.sheetData) {
            selectSheet(obj.sheetData.id);
        }
    });

    canvas.on('selection:updated', function(opt) {
        const obj = opt.selected[0];
        if (obj && obj.sheetData) {
            selectSheet(obj.sheetData.id);
        }
    });
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Handle Ctrl+Z for undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
            return;
        }

        switch(e.key) {
            case '1':
                setMode('pan');
                break;
            case '2':
                setMode('select');
                break;
            case '3':
                setMode('crop');
                break;
            case '4':
                setMode('calibrate');
                break;
            case '5':
                setMode('origin');
                break;
            case 'Escape':
                clearSelection();
                break;
            case '+':
            case '=':
                zoomIn();
                break;
            case '-':
                zoomOut();
                break;
        }
    });
}

// Mode Management
function setMode(mode) {
    console.log('setMode called with:', mode, '(previous mode:', currentMode + ')');
    currentMode = mode;

    // Update button states
    document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Update cursor and object selectability
    const isSelectMode = (mode === 'select');

    switch(mode) {
        case 'pan':
            canvas.defaultCursor = 'grab';
            canvas.selection = false;
            break;
        case 'select':
            canvas.defaultCursor = 'default';
            canvas.selection = true;
            break;
        case 'crop':
            canvas.defaultCursor = 'crosshair';
            canvas.selection = false;  // Prevent box selection
            break;
        case 'split':
            canvas.defaultCursor = 'crosshair';
            canvas.selection = false;  // Prevent box selection
            break;
        case 'calibrate':
            canvas.defaultCursor = 'crosshair';
            calibrationPoints = [];
            break;
        case 'origin':
            canvas.defaultCursor = 'crosshair';
            break;
    }

    // Update selectability of all sheet objects
    // Sheets are selectable only in select mode
    // Sheets must be evented in crop/split mode to detect clicks for cut lines
    const isCropOrSplitMode = (mode === 'crop' || mode === 'split');
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData) {
            obj.selectable = isSelectMode;
            obj.evented = isSelectMode || isCropOrSplitMode;
            obj.hasControls = isSelectMode;  // Show rotation control only in select mode
        }
    });
    canvas.renderAll();

    document.getElementById('current-mode').textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
}

// Data Loading
async function loadProjectData() {
    try {
        // Load sheets
        const sheetsResponse = await fetch(`/api/projects/${PROJECT_ID}/sheets/`);
        sheets = await sheetsResponse.json();

        // Load assets
        const assetsResponse = await fetch(`/api/projects/${PROJECT_ID}/assets/`);
        assets = await assetsResponse.json();

        renderSheetLayers();
        renderAssetList();
        renderSheetsOnCanvas();
        renderAssetsOnCanvas();

    } catch (error) {
        console.error('Error loading project data:', error);
    }
}

function renderSheetLayers() {
    const container = document.getElementById('sheet-layers');
    container.innerHTML = '';

    sheets.forEach(sheet => {
        const div = document.createElement('div');
        div.className = 'layer-item';
        div.dataset.sheetId = sheet.id;

        // Security: Use DOM methods instead of innerHTML to prevent XSS
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'layer-visibility';
        checkbox.checked = true;
        checkbox.addEventListener('change', function() {
            toggleSheetVisibility(sheet.id, this.checked);
        });

        const span = document.createElement('span');
        span.textContent = sheet.name;  // Safe: textContent escapes HTML

        div.appendChild(checkbox);
        div.appendChild(span);

        div.addEventListener('click', (e) => {
            if (e.target.type !== 'checkbox') {
                selectSheet(sheet.id);
            }
        });
        container.appendChild(div);
    });
}

function renderAssetList() {
    const container = document.getElementById('asset-list');
    container.innerHTML = '';

    assets.forEach(asset => {
        const div = document.createElement('div');
        div.className = 'asset-item' + (asset.is_adjusted ? ' adjusted' : '');

        // Security: Use DOM methods instead of innerHTML to prevent XSS
        const strong = document.createElement('strong');
        strong.textContent = asset.asset_id;  // Safe: textContent escapes HTML
        div.appendChild(strong);

        if (asset.name) {
            div.appendChild(document.createElement('br'));
            const small = document.createElement('small');
            small.textContent = asset.name;  // Safe: textContent escapes HTML
            div.appendChild(small);
        }

        const coordsDiv = document.createElement('div');
        coordsDiv.className = 'coordinates';
        coordsDiv.textContent = `X: ${asset.current_x.toFixed(2)}m, Y: ${asset.current_y.toFixed(2)}m`;
        div.appendChild(coordsDiv);

        div.addEventListener('click', () => selectAsset(asset.id));
        container.appendChild(div);
    });

    // Setup search filter
    document.getElementById('asset-search').addEventListener('input', function(e) {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll('.asset-item').forEach((item, index) => {
            const asset = assets[index];
            const matches = asset.asset_id.toLowerCase().includes(query) ||
                          (asset.name && asset.name.toLowerCase().includes(query));
            item.style.display = matches ? '' : 'none';
        });
    });
}

function renderSheetsOnCanvas() {
    // Count sheets with images to load
    const sheetsToLoad = sheets.filter(s => s.rendered_image_url).length;
    let sheetsLoaded = 0;

    sheets.forEach((sheet, index) => {
        if (sheet.rendered_image_url) {
            fabric.Image.fromURL(sheet.rendered_image_url, function(img) {
                // If no offset set, offset sheets so they don't stack
                let left = sheet.offset_x;
                let top = sheet.offset_y;
                if (left === 0 && top === 0 && index > 0) {
                    left = index * 50;  // Offset subsequent sheets
                    top = index * 50;
                }

                img.set({
                    left: left,
                    top: top,
                    angle: sheet.rotation,
                    selectable: currentMode === 'select',
                    evented: true,
                    // Enable rotation control only, disable scaling
                    hasControls: true,
                    hasBorders: true,
                    hasRotatingPoint: true,
                    lockScalingX: true,
                    lockScalingY: true,
                    lockUniScaling: true,
                    lockRotation: false,  // Allow rotation
                    // Rotation control styling
                    cornerSize: 12,
                    cornerColor: '#3498db',
                    cornerStrokeColor: '#2980b9',
                    transparentCorners: false,
                    borderColor: '#3498db',
                    rotatingPointOffset: 30,
                });
                // Only show rotation control (mtr), hide all resize controls
                img.setControlsVisibility({
                    tl: false, tr: false, bl: false, br: false,
                    ml: false, mt: false, mr: false, mb: false,
                    mtr: true  // Show rotation control
                });
                img.sheetData = sheet;
                canvas.add(img);

                // Restore cut mask if sheet has saved cut data
                if (sheet.crop_x !== 0 || sheet.crop_y !== 0 ||
                    sheet.crop_width !== 0 || sheet.crop_height !== 0) {
                    const cutData = {
                        p1: { x: sheet.crop_x, y: sheet.crop_y },
                        p2: { x: sheet.crop_width, y: sheet.crop_height },
                        flipped: sheet.crop_flipped || false  // Use saved flipped state
                    };
                    sheetCutData[sheet.id] = cutData;
                    applyCutMaskWithDirection(img, cutData.p1, cutData.p2, cutData.flipped);
                }

                sheetsLoaded++;

                // Once all sheets are loaded, reorder by z_index
                if (sheetsLoaded === sheetsToLoad) {
                    reorderSheetsByZIndex();
                }

                canvas.renderAll();
            }, { crossOrigin: 'anonymous' });
        }
    });
}

/**
 * Reorder sheet objects on canvas based on their z_index values.
 * Lower z_index = further back (rendered first, behind others)
 */
function reorderSheetsByZIndex() {
    // Get all sheet objects from canvas
    const sheetObjects = canvas.getObjects().filter(obj => obj.sheetData);

    if (sheetObjects.length === 0) return;

    // Sort by z_index (ascending - lower values should be at back)
    sheetObjects.sort((a, b) => a.sheetData.z_index - b.sheetData.z_index);

    // Send each sheet to back in reverse order (highest z_index first)
    // This way, the lowest z_index ends up at the very back
    for (let i = sheetObjects.length - 1; i >= 0; i--) {
        canvas.sendToBack(sheetObjects[i]);
    }

    canvas.renderAll();
    console.log('Sheets reordered by z_index:', sheetObjects.map(o => ({
        name: o.sheetData.name,
        z_index: o.sheetData.z_index
    })));
}

function renderAssetsOnCanvas() {
    assets.forEach(asset => {
        const pixelX = PROJECT_DATA.origin_x + (asset.current_x * PROJECT_DATA.pixels_per_meter);
        const pixelY = PROJECT_DATA.origin_y + (asset.current_y * PROJECT_DATA.pixels_per_meter);

        const assetObj = createAssetShape(asset, pixelX, pixelY);
        assetObj.assetData = asset;
        canvas.add(assetObj);
    });

    canvas.renderAll();
}

function createAssetShape(asset, x, y) {
    const type = asset.asset_type_data;
    const color = type ? type.color : '#FF0000';
    const size = type ? type.size : 20;
    const shape = type ? type.icon_shape : 'circle';

    let obj;

    switch(shape) {
        case 'circle':
            obj = new fabric.Circle({
                radius: size / 2,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'square':
            obj = new fabric.Rect({
                width: size,
                height: size,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'triangle':
            obj = new fabric.Triangle({
                width: size,
                height: size,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'diamond':
            obj = new fabric.Rect({
                width: size * 0.7,
                height: size * 0.7,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                angle: 45,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'star':
            const points = createStarPoints(0, 0, 5, size / 2, size / 4);
            obj = new fabric.Polygon(points, {
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        default:
            obj = new fabric.Circle({
                radius: size / 2,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
    }

    obj.set({
        left: x,
        top: y,
        selectable: true,
        hasControls: false
    });

    // Add label
    const label = new fabric.Text(asset.asset_id, {
        fontSize: 10,
        fill: '#000',
        left: x + size / 2 + 3,
        top: y - 5,
        selectable: false
    });

    const group = new fabric.Group([obj, label], {
        left: x,
        top: y,
        selectable: true,
        hasControls: false,
        hasBorders: true,
        lockScalingX: true,
        lockScalingY: true,
        lockRotation: true,
        cornerSize: 0
    });
    // Hide all control handles
    group.setControlsVisibility({
        tl: false, tr: false, bl: false, br: false,
        ml: false, mt: false, mr: false, mb: false,
        mtr: false
    });

    return group;
}

function createStarPoints(cx, cy, spikes, outerRadius, innerRadius) {
    const points = [];
    const step = Math.PI / spikes;

    for (let i = 0; i < 2 * spikes; i++) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = i * step - Math.PI / 2;
        points.push({
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius
        });
    }

    return points;
}

// Selection Handlers
function handleSelectClick(opt) {
    const target = opt.target;

    if (target) {
        if (target.assetData) {
            selectAsset(target.assetData.id);
        } else if (target.sheetData) {
            selectSheet(target.sheetData.id);
        }
    } else {
        clearSelection();
    }
}

function selectSheet(sheetId) {
    selectedSheet = sheets.find(s => s.id === sheetId);
    selectedAsset = null;

    // Update layer list
    document.querySelectorAll('.layer-item').forEach(item => {
        item.classList.toggle('selected', parseInt(item.dataset.sheetId) === sheetId);
    });

    // Show properties
    document.getElementById('no-selection').style.display = 'none';
    document.getElementById('sheet-properties').style.display = 'block';
    document.getElementById('asset-properties').style.display = 'none';

    // Populate fields
    document.getElementById('sheet-name').value = selectedSheet.name;
    document.getElementById('sheet-offset-x').value = selectedSheet.offset_x;
    document.getElementById('sheet-offset-y').value = selectedSheet.offset_y;
    document.getElementById('sheet-rotation').value = selectedSheet.rotation;
    document.getElementById('sheet-zindex').value = selectedSheet.z_index;
}

function selectAsset(assetId) {
    selectedAsset = assets.find(a => a.id === assetId);
    selectedSheet = null;

    // Highlight on canvas
    canvas.getObjects().forEach(obj => {
        if (obj.assetData && obj.assetData.id === assetId) {
            canvas.setActiveObject(obj);
        }
    });

    // Show properties
    document.getElementById('no-selection').style.display = 'none';
    document.getElementById('sheet-properties').style.display = 'none';
    document.getElementById('asset-properties').style.display = 'block';

    // Populate fields
    document.getElementById('asset-id').value = selectedAsset.asset_id;
    document.getElementById('asset-name').value = selectedAsset.name || '';
    document.getElementById('asset-orig-x').value = selectedAsset.original_x;
    document.getElementById('asset-orig-y').value = selectedAsset.original_y;
    document.getElementById('asset-adj-x').value = selectedAsset.adjusted_x || selectedAsset.original_x;
    document.getElementById('asset-adj-y').value = selectedAsset.adjusted_y || selectedAsset.original_y;

    showTab('properties');
}

function clearSelection() {
    selectedSheet = null;
    selectedAsset = null;
    canvas.discardActiveObject();
    canvas.renderAll();

    document.querySelectorAll('.layer-item').forEach(item => {
        item.classList.remove('selected');
    });

    document.getElementById('no-selection').style.display = 'block';
    document.getElementById('sheet-properties').style.display = 'none';
    document.getElementById('asset-properties').style.display = 'none';
}

// Delete selected sheet
async function deleteSelectedSheet() {
    if (!selectedSheet) {
        console.log('No sheet selected for deletion');
        return;
    }

    const sheetName = selectedSheet.name;
    const confirmed = confirm(`Are you sure you want to delete "${sheetName}"? This cannot be undone.`);

    if (!confirmed) return;

    try {
        const response = await fetch(`/api/sheets/${selectedSheet.id}/`, {
            method: 'DELETE',
            headers: {
                'X-CSRFToken': getCSRFToken()
            }
        });

        if (response.ok || response.status === 204) {
            // Remove from canvas
            canvas.getObjects().forEach(obj => {
                if (obj.sheetData && obj.sheetData.id === selectedSheet.id) {
                    canvas.remove(obj);
                }
            });
            canvas.renderAll();

            // Remove from local data
            const index = sheets.findIndex(s => s.id === selectedSheet.id);
            if (index >= 0) {
                sheets.splice(index, 1);
            }

            // Clear cut data for this sheet
            delete sheetCutData[selectedSheet.id];

            // Clear selection and refresh UI
            clearSelection();
            renderSheetLayers();

            console.log('Sheet deleted:', sheetName);
        } else {
            const error = await response.json();
            alert('Error deleting sheet: ' + JSON.stringify(error));
        }
    } catch (error) {
        console.error('Error deleting sheet:', error);
        alert('Error deleting sheet');
    }
}

// Calibration
function handleCalibrationClick(opt) {
    const pointer = canvas.getPointer(opt.e);
    calibrationPoints.push({ x: pointer.x, y: pointer.y });

    // Draw calibration point marker
    const marker = new fabric.Circle({
        radius: 5,
        fill: '#FF0000',
        left: pointer.x,
        top: pointer.y,
        originX: 'center',
        originY: 'center',
        selectable: false,
        calibrationMarker: true
    });
    canvas.add(marker);

    if (calibrationPoints.length === 2) {
        // Calculate pixel distance
        const dx = calibrationPoints[1].x - calibrationPoints[0].x;
        const dy = calibrationPoints[1].y - calibrationPoints[0].y;
        const pixelDistance = Math.sqrt(dx * dx + dy * dy);

        document.getElementById('pixel-distance').value = pixelDistance.toFixed(2);
        document.getElementById('calibrateModal').style.display = 'block';
    }
}

async function applyCalibration() {
    const pixelDistance = parseFloat(document.getElementById('pixel-distance').value);
    const realDistance = parseFloat(document.getElementById('real-distance').value);

    if (!realDistance || realDistance <= 0) {
        alert('Please enter a valid real-world distance');
        return;
    }

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                pixel_distance: pixelDistance,
                real_distance: realDistance
            })
        });

        const result = await response.json();
        PROJECT_DATA.pixels_per_meter = result.pixels_per_meter;

        // Clear calibration markers
        canvas.getObjects().forEach(obj => {
            if (obj.calibrationMarker) canvas.remove(obj);
        });

        calibrationPoints = [];
        hideCalibrateModal();
        setMode('pan');

        // Refresh assets with new scale
        refreshAssets();

    } catch (error) {
        console.error('Calibration error:', error);
        alert('Error applying calibration');
    }
}

function hideCalibrateModal() {
    document.getElementById('calibrateModal').style.display = 'none';
}

// Origin Setting
async function handleOriginClick(opt) {
    const pointer = canvas.getPointer(opt.e);

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                origin_x: pointer.x,
                origin_y: pointer.y
            })
        });

        const result = await response.json();
        PROJECT_DATA.origin_x = result.origin_x;
        PROJECT_DATA.origin_y = result.origin_y;

        // Draw origin marker
        drawOriginMarker(pointer.x, pointer.y);

        setMode('pan');
        refreshAssets();

    } catch (error) {
        console.error('Origin setting error:', error);
    }
}

function drawOriginMarker(x, y) {
    // Remove existing origin marker
    canvas.getObjects().forEach(obj => {
        if (obj.originMarker) canvas.remove(obj);
    });

    const marker = new fabric.Group([
        new fabric.Line([x - 20, y, x + 20, y], { stroke: '#0000FF', strokeWidth: 2 }),
        new fabric.Line([x, y - 20, x, y + 20], { stroke: '#0000FF', strokeWidth: 2 }),
        new fabric.Circle({ radius: 8, fill: 'transparent', stroke: '#0000FF', strokeWidth: 2, left: x, top: y, originX: 'center', originY: 'center' })
    ], { selectable: false, originMarker: true });

    canvas.add(marker);
    canvas.renderAll();
}

// Asset Position Updates
function updateAssetPositionFromCanvas(obj) {
    if (!obj.assetData) return;

    // Convert pixel position back to meters
    const pixelX = obj.left;
    const pixelY = obj.top;

    const meterX = (pixelX - PROJECT_DATA.origin_x) / PROJECT_DATA.pixels_per_meter;
    const meterY = (pixelY - PROJECT_DATA.origin_y) / PROJECT_DATA.pixels_per_meter;

    // Update the property panel if this asset is selected
    if (selectedAsset && selectedAsset.id === obj.assetData.id) {
        document.getElementById('asset-adj-x').value = meterX.toFixed(3);
        document.getElementById('asset-adj-y').value = meterY.toFixed(3);
    }
}

async function saveAssetAdjustment() {
    if (!selectedAsset) return;

    const newX = parseFloat(document.getElementById('asset-adj-x').value);
    const newY = parseFloat(document.getElementById('asset-adj-y').value);
    const notes = document.getElementById('asset-notes').value;

    try {
        const response = await fetch(`/api/assets/${selectedAsset.id}/adjust/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ x: newX, y: newY, notes: notes })
        });

        if (response.ok) {
            const updated = await response.json();
            // Update local data
            const index = assets.findIndex(a => a.id === selectedAsset.id);
            assets[index] = updated;
            selectedAsset = updated;

            renderAssetList();
            refreshAssets();
            alert('Asset adjustment saved');
        }
    } catch (error) {
        console.error('Error saving adjustment:', error);
        alert('Error saving adjustment');
    }
}

// Sheet Position Updates
function updateSheetPositionFromCanvas(obj) {
    if (!obj.sheetData) return;

    // Auto-save position changes using the object's sheet data directly
    const sheetId = obj.sheetData.id;
    saveSheetPosition(sheetId, obj.left, obj.top);
}

function updateSheetRotationFromCanvas(obj) {
    if (!obj.sheetData) return;

    const sheetId = obj.sheetData.id;
    const rotation = obj.angle;

    // Update local data
    const index = sheets.findIndex(s => s.id === sheetId);
    if (index >= 0) {
        sheets[index].rotation = rotation;
    }

    // Update properties panel if this sheet is selected
    if (selectedSheet && selectedSheet.id === sheetId) {
        selectedSheet.rotation = rotation;
        document.getElementById('sheet-rotation').value = rotation.toFixed(1);
    }

    // Save to server
    saveSheetRotation(sheetId, rotation);
}

async function saveSheetRotation(sheetId, rotation) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ rotation: rotation })
        });

        if (!response.ok) {
            console.error('Error saving sheet rotation:', await response.text());
        } else {
            console.log('Sheet rotation saved:', rotation);
        }
    } catch (error) {
        console.error('Error saving sheet rotation:', error);
    }
}

async function saveSheetPosition(sheetId, x, y) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ offset_x: x, offset_y: y })
        });

        if (response.ok) {
            const updated = await response.json();
            const index = sheets.findIndex(s => s.id === sheetId);
            if (index >= 0) {
                sheets[index] = updated;
                if (selectedSheet && selectedSheet.id === sheetId) {
                    selectedSheet = updated;
                    document.getElementById('sheet-offset-x').value = updated.offset_x;
                    document.getElementById('sheet-offset-y').value = updated.offset_y;
                }
            }
        }
    } catch (error) {
        console.error('Error saving sheet position:', error);
    }
}

async function updateSheetProperty(property, value, reload = true) {
    if (!selectedSheet) return;

    const data = {};
    data[property] = value;

    try {
        const response = await fetch(`/api/sheets/${selectedSheet.id}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify(data)
        });

        if (response.ok && reload) {
            const updated = await response.json();
            const index = sheets.findIndex(s => s.id === selectedSheet.id);
            sheets[index] = updated;
            selectedSheet = updated;

            // Update the canvas object visually
            updateSheetOnCanvas(selectedSheet.id, property, value);
        }
    } catch (error) {
        console.error('Error updating sheet:', error);
    }
}

function updateSheetOnCanvas(sheetId, property, value) {
    // Find the sheet object on canvas and update its visual property
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData && obj.sheetData.id === sheetId) {
            switch (property) {
                case 'rotation':
                    obj.set('angle', parseFloat(value));
                    break;
                case 'offset_x':
                    obj.set('left', parseFloat(value));
                    break;
                case 'offset_y':
                    obj.set('top', parseFloat(value));
                    break;
                case 'z_index':
                    // Re-order layers based on z_index
                    // Higher z_index = more to front
                    const zIndex = parseInt(value);
                    if (zIndex > 0) {
                        canvas.bringToFront(obj);
                    } else {
                        canvas.sendToBack(obj);
                    }
                    break;
            }
            obj.setCoords();  // Update object coordinates after transformation
            canvas.renderAll();
        }
    });
}

// Refresh Functions
function refreshAssets() {
    // Remove existing asset objects
    canvas.getObjects().forEach(obj => {
        if (obj.assetData) canvas.remove(obj);
    });

    // Re-render
    renderAssetsOnCanvas();
}

function toggleSheetVisibility(sheetId, visible) {
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData && obj.sheetData.id === sheetId) {
            obj.visible = visible;
        }
    });
    canvas.renderAll();
}

// Zoom Controls
function zoomIn() {
    let zoom = canvas.getZoom() * 1.2;
    if (zoom > 5) zoom = 5;
    setZoomPreservingRotation(zoom);
    updateZoomDisplay();
}

function zoomOut() {
    let zoom = canvas.getZoom() / 1.2;
    if (zoom < 0.1) zoom = 0.1;
    setZoomPreservingRotation(zoom);
    updateZoomDisplay();
}

/**
 * Set zoom while preserving the current viewport rotation
 * @param {number} zoom - New zoom level
 */
function setZoomPreservingRotation(zoom) {
    const angleRad = viewportRotation * Math.PI / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const vpt = canvas.viewportTransform;

    // Apply zoom with rotation
    vpt[0] = cos * zoom;
    vpt[1] = sin * zoom;
    vpt[2] = -sin * zoom;
    vpt[3] = cos * zoom;
    // Keep pan values unchanged

    canvas.setViewportTransform(vpt);
}

function zoomFit() {
    // Calculate bounds of all objects
    const objects = canvas.getObjects().filter(obj => obj.sheetData);
    if (objects.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objects.forEach(obj => {
        const bounds = obj.getBoundingRect();
        minX = Math.min(minX, bounds.left);
        minY = Math.min(minY, bounds.top);
        maxX = Math.max(maxX, bounds.left + bounds.width);
        maxY = Math.max(maxY, bounds.top + bounds.height);
    });

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    const zoomX = canvas.width / contentWidth * 0.9;
    const zoomY = canvas.height / contentHeight * 0.9;
    const zoom = Math.min(zoomX, zoomY, 1);

    canvas.setZoom(zoom);
    canvas.absolutePan({
        x: minX * zoom - (canvas.width - contentWidth * zoom) / 2,
        y: minY * zoom - (canvas.height - contentHeight * zoom) / 2
    });

    updateZoomDisplay();
}

function resetView() {
    setZoomPreservingRotation(1);
    canvas.absolutePan({ x: 0, y: 0 });
    applyViewportRotation();  // Re-apply rotation after pan
    updateZoomDisplay();
}

function updateZoomDisplay() {
    const zoom = Math.round(canvas.getZoom() * 100);
    document.getElementById('zoom-level').textContent = zoom;
    document.getElementById('zoom-display').textContent = zoom + '%';
}

// Viewport Rotation Functions
let rotationSaveTimeout = null;

/**
 * Set the viewport rotation to a specific angle
 * @param {number} degrees - Rotation angle in degrees
 */
function setViewportRotation(degrees) {
    viewportRotation = ((degrees % 360) + 360) % 360;  // Normalize to 0-360
    applyViewportRotation();
    updateRotationDisplay();
    debouncedSaveRotation();
}

/**
 * Rotate the viewport by a delta amount
 * @param {number} delta - Degrees to rotate by (positive = clockwise)
 */
function rotateViewportBy(delta) {
    setViewportRotation(viewportRotation + delta);
}

/**
 * Apply the current viewport rotation to the canvas
 */
function applyViewportRotation() {
    const angleRad = viewportRotation * Math.PI / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const vpt = canvas.viewportTransform;
    const currentZoom = canvas.getZoom();

    // Get current pan position
    const panX = vpt[4];
    const panY = vpt[5];

    // Apply rotation with current zoom
    // Matrix: [scaleX*cos, scaleY*sin, -scaleX*sin, scaleY*cos, panX, panY]
    vpt[0] = cos * currentZoom;
    vpt[1] = sin * currentZoom;
    vpt[2] = -sin * currentZoom;
    vpt[3] = cos * currentZoom;
    // Keep pan values
    vpt[4] = panX;
    vpt[5] = panY;

    canvas.setViewportTransform(vpt);
    canvas.requestRenderAll();
}

/**
 * Update the rotation display in the UI
 */
function updateRotationDisplay() {
    const displayAngle = Math.round(viewportRotation);
    document.getElementById('rotation-level').textContent = displayAngle;
    const rotationInput = document.getElementById('viewport-rotation');
    if (rotationInput) {
        rotationInput.value = displayAngle;
    }
}

/**
 * Save viewport rotation to server (debounced)
 */
function debouncedSaveRotation() {
    if (rotationSaveTimeout) {
        clearTimeout(rotationSaveTimeout);
    }
    rotationSaveTimeout = setTimeout(saveViewportRotation, 500);
}

async function saveViewportRotation() {
    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ canvas_rotation: viewportRotation })
        });

        if (response.ok) {
            const result = await response.json();
            PROJECT_DATA.canvas_rotation = result.canvas_rotation;
            console.log('Viewport rotation saved:', viewportRotation);
        }
    } catch (error) {
        console.error('Error saving viewport rotation:', error);
    }
}

function updateCursorPosition(opt) {
    const pointer = canvas.getPointer(opt.e);

    // Convert to meters if calibrated
    const meterX = (pointer.x - PROJECT_DATA.origin_x) / PROJECT_DATA.pixels_per_meter;
    const meterY = (pointer.y - PROJECT_DATA.origin_y) / PROJECT_DATA.pixels_per_meter;

    document.getElementById('cursor-position').textContent =
        `${meterX.toFixed(2)}m, ${meterY.toFixed(2)}m`;
}

// Tab Switching
function showTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === tabName + '-tab');
    });
}

// Modal Functions
function showUploadModal() {
    document.getElementById('uploadModal').style.display = 'block';
}

function hideUploadModal() {
    document.getElementById('uploadModal').style.display = 'none';
}

function showImportModal() {
    document.getElementById('importModal').style.display = 'block';
}

function hideImportModal() {
    document.getElementById('importModal').style.display = 'none';
}

// Form Handlers
document.getElementById('uploadForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const formData = new FormData(this);

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/sheets/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCSRFToken()
            },
            body: formData
        });

        if (response.ok) {
            const result = await response.json();
            hideUploadModal();

            // Show message about how many sheets were created
            if (Array.isArray(result)) {
                const count = result.length;
                if (count > 1) {
                    alert(`PDF imported successfully! Created ${count} sheets (one per page).`);
                }
            }

            loadProjectData();
            this.reset();  // Reset form for next upload
        } else {
            const error = await response.json();
            alert('Error: ' + JSON.stringify(error));
        }
    } catch (error) {
        console.error('Upload error:', error);
    }
});

document.getElementById('importForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const formData = new FormData(this);

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/import-csv/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCSRFToken()
            },
            body: formData
        });

        const result = await response.json();
        if (response.ok) {
            alert(`Import complete:\n${result.created} created\n${result.updated} updated\n${result.errors.length} errors`);
            hideImportModal();
            loadProjectData();
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Import error:', error);
    }
});

// Export Functions
async function exportProject() {
    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/export/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({})
        });

        const result = await response.json();
        if (response.ok) {
            alert('Export complete! Files saved to: ' + result.exports.map(e => e.output_path).join(', '));
        } else {
            alert('Export error: ' + result.error);
        }
    } catch (error) {
        console.error('Export error:', error);
    }
}

function downloadReport() {
    window.open(`/api/projects/${PROJECT_ID}/adjustment-report/?format=csv`, '_blank');
}

// Cut Line Tool - draws a line to hide one side of a sheet
let cutLine = null;
let cutLineStart = null;
let targetSheetObj = null;

/**
 * Check if a point is in the visible (non-clipped) area of an object
 * @param {fabric.Object} obj - The object with clipPath
 * @param {Object} pointer - Canvas coordinates {x, y}
 * @returns {boolean} - True if point is in visible area
 */
function isPointInVisibleArea(obj, pointer) {
    if (!obj.clipPath) return true;

    // Convert pointer to object-local coordinates
    const point = new fabric.Point(pointer.x, pointer.y);
    const invertedMatrix = fabric.util.invertTransform(obj.calcTransformMatrix());
    const localPoint = fabric.util.transformPoint(point, invertedMatrix);

    // Check if point is inside the clipPath polygon
    return obj.clipPath.containsPoint(localPoint);
}

function handleCropClick(opt) {
    const pointer = canvas.getPointer(opt.e);

    console.log('handleCropClick called, pointer:', pointer, 'isCropping:', isCropping);

    // Find sheet under click - try multiple methods for reliability
    let clickedSheetObj = null;

    // Method 1: Use opt.target if available
    if (opt.target && opt.target.sheetData) {
        clickedSheetObj = opt.target;
        console.log('Method 1 - opt.target:', opt.target.sheetData.name);
    }

    // Method 2: Use findTarget with event
    if (!clickedSheetObj) {
        const foundObj = canvas.findTarget(opt.e, true);
        if (foundObj && foundObj.sheetData) {
            clickedSheetObj = foundObj;
            console.log('Method 2 - findTarget:', foundObj.sheetData.name);
        }
    }

    // Method 3: Use getBoundingRect for proper rotation handling
    if (!clickedSheetObj) {
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) {
                // Use getBoundingRect which properly accounts for rotation
                const bounds = obj.getBoundingRect();
                if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                    pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                    clickedSheetObj = obj;
                    console.log('Method 3 - bounding rect:', obj.sheetData.name);
                }
            }
        });
    }

    // Method 4: Check if point is in visible area (not clipped)
    if (clickedSheetObj && clickedSheetObj.clipPath) {
        if (!isPointInVisibleArea(clickedSheetObj, pointer)) {
            console.log('Point is in clipped area, looking for sheet underneath');
            const clippedSheet = clickedSheetObj;
            clickedSheetObj = null;
            // Look for another sheet underneath
            canvas.getObjects().forEach(obj => {
                if (obj.sheetData && obj !== clippedSheet) {
                    const bounds = obj.getBoundingRect();
                    if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                        pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                        if (!obj.clipPath || isPointInVisibleArea(obj, pointer)) {
                            clickedSheetObj = obj;
                        }
                    }
                }
            });
        }
    }

    console.log('All sheets on canvas:', canvas.getObjects().filter(o => o.sheetData).length);

    if (!isCropping) {
        // Start cut line
        if (!clickedSheetObj) {
            console.log('Cut line must start on a sheet - no sheet found under click');
            console.log('Available sheets:', canvas.getObjects().filter(o => o.sheetData).map(o => o.sheetData.name));
            return;
        }

        targetSheetObj = clickedSheetObj;
        selectSheet(targetSheetObj.sheetData.id);
        isCropping = true;
        cutLineStart = pointer;

        console.log('Starting cut line at:', pointer);

        // Draw the cut line
        cutLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: '#ff0000',
            strokeWidth: 3,
            strokeDashArray: [10, 5],
            selectable: false,
            evented: false
        });
        canvas.add(cutLine);
        canvas.bringToFront(cutLine);
        canvas.renderAll();
        console.log('Cut line added to canvas');
    }
}

function handleCropMove(opt) {
    if (!isCropping || !cutLine || !cutLineStart) return;

    const pointer = canvas.getPointer(opt.e);
    cutLine.set({ x2: pointer.x, y2: pointer.y });
    canvas.renderAll();
}

// Debug: Log mode changes
const originalSetMode = setMode;
// Overwrite setMode to add logging (will be defined later in file, so we patch it at load time)
document.addEventListener('DOMContentLoaded', function() {
    console.log('Canvas editor loaded, currentMode:', currentMode);
});

function handleCropEnd(opt) {
    if (!isCropping || !cutLine || !cutLineStart || !targetSheetObj) return;

    const pointer = canvas.getPointer(opt.e);

    // Calculate line length
    const dx = pointer.x - cutLineStart.x;
    const dy = pointer.y - cutLineStart.y;
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    if (lineLength > 20) {
        // Apply cut mask to the sheet
        applyCutMask(targetSheetObj, cutLineStart, pointer);
    }

    // Clean up
    canvas.remove(cutLine);
    cutLine = null;
    cutLineStart = null;
    targetSheetObj = null;
    isCropping = false;
}

function applyCutMask(sheetObj, p1, p2) {
    const sheetId = sheetObj.sheetData.id;

    // Save undo state - capture previous cut data (if any)
    const previousCutData = sheetCutData[sheetId] ? JSON.parse(JSON.stringify(sheetCutData[sheetId])) : null;
    saveUndoState('cut', {
        sheetId: sheetId,
        previousCutData: previousCutData
    });

    // Store cut data for flipping later
    const cutData = {
        p1: { x: p1.x, y: p1.y },
        p2: { x: p2.x, y: p2.y },
        flipped: false
    };
    sheetCutData[sheetId] = cutData;

    applyCutMaskWithDirection(sheetObj, p1, p2, false);
    saveCutData(sheetId, cutData);
    console.log('Cut applied to sheet:', sheetObj.sheetData.name);
}

function applyCutMaskWithDirection(sheetObj, p1, p2, flipped) {
    // Get the sheet's dimensions in local coordinates
    const imgWidth = sheetObj.width;
    const imgHeight = sheetObj.height;

    // Convert canvas coordinates to object-local coordinates
    // Must use Fabric.js transform matrix for proper handling of rotation/scale
    const toLocal = (canvasX, canvasY) => {
        const point = new fabric.Point(canvasX, canvasY);
        // Get the inverse of the object's transform matrix
        const invertedMatrix = fabric.util.invertTransform(sheetObj.calcTransformMatrix());
        // Transform the point from canvas space to object space
        const transformed = fabric.util.transformPoint(point, invertedMatrix);
        return { x: transformed.x, y: transformed.y };
    };

    const localP1 = toLocal(p1.x, p1.y);
    const localP2 = toLocal(p2.x, p2.y);

    // Calculate the line direction and perpendicular
    const dx = localP2.x - localP1.x;
    const dy = localP2.y - localP1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;

    // Normalize
    const nx = dx / len;
    const ny = dy / len;

    // Calculate perpendicular (initially use right-hand rule: 90 degrees CCW)
    let px = -ny;
    let py = nx;

    // Determine which side of the line the sheet center is on
    // Sheet center in local coordinates is at (imgWidth/2, imgHeight/2) relative to the image origin
    // But for Fabric.js images with default origin, the local (0,0) is at the image center
    // So we need to check which side of the line the origin (0,0) is on
    const sheetCenterX = 0;  // Local center of Fabric.js image
    const sheetCenterY = 0;

    // Calculate midpoint of the cut line
    const midX = (localP1.x + localP2.x) / 2;
    const midY = (localP1.y + localP2.y) / 2;

    // Vector from line midpoint to sheet center
    const toSheetCenterX = sheetCenterX - midX;
    const toSheetCenterY = sheetCenterY - midY;

    // Dot product with perpendicular tells us which side the center is on
    const dotProduct = toSheetCenterX * px + toSheetCenterY * py;

    // If dot product is negative, the center is on the opposite side of perpendicular
    // So flip the perpendicular to point toward the center
    if (dotProduct < 0) {
        px = -px;
        py = -py;
    }

    // Now apply the user's flip preference
    if (flipped) {
        px = -px;
        py = -py;
    }

    console.log('Cut direction - perpendicular:', {px, py}, 'dotProduct:', dotProduct, 'flipped:', flipped);

    // Use image dimensions for padding to ensure full coverage
    // Image dimensions in local space
    const padding = Math.max(imgWidth, imgHeight) * 1.5;

    // Line endpoints extended
    const l1x = localP1.x - nx * padding;
    const l1y = localP1.y - ny * padding;
    const l2x = localP2.x + nx * padding;
    const l2y = localP2.y + ny * padding;

    // Points on the "keep" side (extends perpendicular to the line)
    const k1x = l1x + px * padding;
    const k1y = l1y + py * padding;
    const k2x = l2x + px * padding;
    const k2y = l2y + py * padding;

    const clipPoints = [
        { x: l1x, y: l1y },
        { x: l2x, y: l2y },
        { x: k2x, y: k2y },
        { x: k1x, y: k1y }
    ];

    // Create clip path polygon - use object-relative coordinates
    const clipPath = new fabric.Polygon(clipPoints, {
        originX: 'left',
        originY: 'top',
        absolutePositioned: false
    });

    sheetObj.clipPath = clipPath;
    // Ensure clip path bounds are calculated
    if (sheetObj.clipPath.setCoords) {
        sheetObj.clipPath.setCoords();
    }
    sheetObj.dirty = true;
    canvas.renderAll();
    console.log('Clip applied with points:', clipPoints);
}

async function saveCutData(sheetId, cutData) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                crop_x: cutData.p1.x,
                crop_y: cutData.p1.y,
                crop_width: cutData.p2.x,
                crop_height: cutData.p2.y,
                crop_flipped: cutData.flipped || false
            })
        });
        if (response.ok) {
            console.log('Cut data saved (flipped:', cutData.flipped, ')');
        }
    } catch (error) {
        console.error('Error saving cut data:', error);
    }
}

function clearSheetCut(sheetId) {
    // Find the sheet object and remove its clip path
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData && obj.sheetData.id === sheetId) {
            obj.clipPath = null;
            canvas.renderAll();
        }
    });
}

function clearSelectedSheetCut() {
    if (!selectedSheet) {
        console.log('No sheet selected for clearing cut');
        return;
    }

    // Save undo state before clearing - capture current cut data
    const existingCutData = sheetCutData[selectedSheet.id];
    if (existingCutData) {
        saveUndoState('clearCut', {
            sheetId: selectedSheet.id,
            cutData: JSON.parse(JSON.stringify(existingCutData))
        });
    }

    clearSheetCut(selectedSheet.id);
    delete sheetCutData[selectedSheet.id];

    // Clear saved cut data
    fetch(`/api/sheets/${selectedSheet.id}/`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': getCSRFToken()
        },
        body: JSON.stringify({
            crop_x: 0,
            crop_y: 0,
            crop_width: 0,
            crop_height: 0
        })
    });
    console.log('Cut cleared from sheet:', selectedSheet.name);
}

function flipSelectedSheetCut() {
    if (!selectedSheet) {
        console.log('No sheet selected for flip');
        return;
    }

    const cutData = sheetCutData[selectedSheet.id];
    if (!cutData) {
        console.log('No cut data to flip');
        return;
    }

    // Find the sheet object
    let sheetObj = null;
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData && obj.sheetData.id === selectedSheet.id) {
            sheetObj = obj;
        }
    });

    if (!sheetObj) return;

    // Flip the cut direction
    cutData.flipped = !cutData.flipped;
    sheetCutData[selectedSheet.id] = cutData;

    // Reapply with flipped direction
    applyCutMaskWithDirection(sheetObj, cutData.p1, cutData.p2, cutData.flipped);

    // Save the flipped state to server
    saveCutData(selectedSheet.id, cutData);
}

// Split Sheet Tool - splits a sheet into two independent pieces
let splitLine = null;
let splitLineStart = null;
let splitTargetSheet = null;
let isSplitting = false;

function handleSplitClick(opt) {
    const pointer = canvas.getPointer(opt.e);

    console.log('handleSplitClick called, pointer:', pointer, 'isSplitting:', isSplitting);

    // Find sheet under click using same methods as crop
    let clickedSheetObj = null;

    if (opt.target && opt.target.sheetData) {
        clickedSheetObj = opt.target;
    }

    if (!clickedSheetObj) {
        const foundObj = canvas.findTarget(opt.e, true);
        if (foundObj && foundObj.sheetData) {
            clickedSheetObj = foundObj;
        }
    }

    if (!clickedSheetObj) {
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) {
                const bounds = obj.getBoundingRect();
                if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                    pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                    clickedSheetObj = obj;
                }
            }
        });
    }

    if (!isSplitting) {
        if (!clickedSheetObj) {
            console.log('Split line must start on a sheet');
            return;
        }

        splitTargetSheet = clickedSheetObj;
        selectSheet(splitTargetSheet.sheetData.id);
        isSplitting = true;
        splitLineStart = pointer;

        console.log('Starting split line at:', pointer);

        // Draw the split line (different color from cut)
        splitLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: '#00ff00',  // Green for split
            strokeWidth: 3,
            strokeDashArray: [10, 5],
            selectable: false,
            evented: false
        });
        canvas.add(splitLine);
        canvas.bringToFront(splitLine);
        canvas.renderAll();
    }
}

function handleSplitMove(opt) {
    if (!isSplitting || !splitLine || !splitLineStart) return;

    const pointer = canvas.getPointer(opt.e);
    splitLine.set({ x2: pointer.x, y2: pointer.y });
    canvas.renderAll();
}

async function handleSplitEnd(opt) {
    if (!isSplitting || !splitLine || !splitLineStart || !splitTargetSheet) return;

    const pointer = canvas.getPointer(opt.e);

    // Calculate line length
    const dx = pointer.x - splitLineStart.x;
    const dy = pointer.y - splitLineStart.y;
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    if (lineLength > 20) {
        // Call API to split the sheet
        try {
            const response = await fetch(`/api/sheets/${splitTargetSheet.sheetData.id}/split/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCSRFToken()
                },
                body: JSON.stringify({
                    p1: { x: splitLineStart.x, y: splitLineStart.y },
                    p2: { x: pointer.x, y: pointer.y }
                })
            });

            if (response.ok) {
                const result = await response.json();
                console.log('Sheet split successfully:', result);

                // Apply cut mask to original sheet (one side)
                const cutData = {
                    p1: splitLineStart,
                    p2: pointer,
                    flipped: false
                };
                sheetCutData[splitTargetSheet.sheetData.id] = cutData;
                applyCutMaskWithDirection(splitTargetSheet, splitLineStart, pointer, false);

                // Add new sheet to canvas with opposite cut
                const newSheet = result.new_sheet;
                sheets.push(newSheet);
                renderSheetLayers();

                // Load the new sheet onto canvas
                if (newSheet.rendered_image_url) {
                    fabric.Image.fromURL(newSheet.rendered_image_url, function(img) {
                        img.set({
                            left: newSheet.offset_x,
                            top: newSheet.offset_y,
                            angle: newSheet.rotation,
                            selectable: currentMode === 'select',
                            evented: true,
                            hasControls: true,
                            hasBorders: true,
                            hasRotatingPoint: true,
                            lockScalingX: true,
                            lockScalingY: true,
                            lockUniScaling: true,
                            lockRotation: false,
                            cornerSize: 12,
                            cornerColor: '#3498db',
                            cornerStrokeColor: '#2980b9',
                            transparentCorners: false,
                            borderColor: '#3498db',
                            rotatingPointOffset: 30,
                        });
                        img.setControlsVisibility({
                            tl: false, tr: false, bl: false, br: false,
                            ml: false, mt: false, mr: false, mb: false,
                            mtr: true
                        });
                        img.sheetData = newSheet;
                        canvas.add(img);

                        // Apply opposite cut to new sheet
                        const newCutData = {
                            p1: { x: newSheet.crop_x, y: newSheet.crop_y },
                            p2: { x: newSheet.crop_width, y: newSheet.crop_height },
                            flipped: true  // Opposite side
                        };
                        sheetCutData[newSheet.id] = newCutData;
                        applyCutMaskWithDirection(img, newCutData.p1, newCutData.p2, newCutData.flipped);

                        canvas.renderAll();
                    }, { crossOrigin: 'anonymous' });
                }

                alert('Sheet split successfully! The new sheet shows the opposite side.');
            } else {
                const error = await response.json();
                alert('Error splitting sheet: ' + JSON.stringify(error));
            }
        } catch (error) {
            console.error('Error splitting sheet:', error);
            alert('Error splitting sheet');
        }
    }

    // Clean up
    canvas.remove(splitLine);
    splitLine = null;
    splitLineStart = null;
    splitTargetSheet = null;
    isSplitting = false;
}

// Close modals on outside click
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', function(e) {
        if (e.target === this) {
            this.style.display = 'none';
        }
    });
});
