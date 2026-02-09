# PDFTool

A Django-based PDF alignment and asset overlay tool. Upload multi-page PDF drawings, stitch and crop sheets on an interactive canvas, then plot geo-referenced assets from CSV data.

## Features

- **PDF Upload & Multi-Page Support** — Upload PDFs and split them into individual sheets automatically
- **Interactive Canvas Editor** — Pan, zoom, rotate and arrange sheets on a Fabric.js canvas
- **Cut & Stitch** — Crop sheets with multi-cut lines and align them visually
- **CSV Asset Import** — Import assets from CSV with flexible column mapping and batch management
- **Coordinate Systems** — Supports meters, WGS84 lat/lon, GDA94 Geographic, and GDA94 MGA
- **Reference Point Calibration** — Anchor assets to a known reference point for accurate placement
- **Scale Calibration** — Set pixels-per-meter with a two-point measurement tool
- **Custom Icons** — Upload custom marker icons per asset type
- **Dark Mode** — Full light/dark theme support
- **Export** — Export the composed canvas as a PDF

## Tech Stack

- **Backend:** Django 4.2, Django REST Framework
- **Frontend:** Fabric.js canvas, vanilla JavaScript
- **PDF Processing:** PyMuPDF, ReportLab, Pillow
- **Database:** SQLite
- **CI:** GitHub Actions (pytest)

## Getting Started

### Prerequisites

- Python 3.10+

### Installation

```bash
# Clone the repo
git clone <repo-url>
cd pdftool

# Create a virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

# Install dependencies
pip install -r requirements.txt

# Set up environment variables
cp .env.example .env
# Edit .env and set DJANGO_SECRET_KEY to a secure value
```

### Setup

```bash
# Run migrations
python manage.py migrate

# Create a superuser (optional, for admin access)
python manage.py createsuperuser

# Start the development server
python manage.py runserver
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DJANGO_SECRET_KEY` | Django secret key (required) | — |
| `DJANGO_DEBUG` | Enable debug mode | `False` |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated allowed hosts | `localhost,127.0.0.1` |

## Running Tests

```bash
pip install -r requirements-test.txt
pytest
```

## Project Structure

```
pdftool/
  pdftool/          # Django project settings & URLs
  drawings/         # Main app
    models.py       # Project, Sheet, Asset, ImportBatch, etc.
    api_views.py    # REST API endpoints
    services/       # pdf_processor, csv_importer, export_service
    tests.py        # Test suite
  templates/        # Django templates (editor, project list/detail)
  static/js/        # Fabric.js canvas editor
  media/            # Uploaded PDFs and rendered sheets
```
