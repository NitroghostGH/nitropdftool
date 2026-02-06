"""CSV import service for asset data."""
import csv
import io
import logging
from django.db import transaction
from ..models import Asset, AssetType, ImportBatch

logger = logging.getLogger(__name__)

# Default column names when no mapping is provided
DEFAULT_MAPPING = {
    'asset_id': 'asset_id',
    'asset_type': 'asset_type',
    'x': 'x',
    'y': 'y',
    'name': 'name',
}


def import_assets_from_csv(project, csv_file, column_mapping=None, filename=None):
    """
    Import assets from a CSV file into a project.

    Args:
        project: Project model instance
        csv_file: Uploaded file object
        column_mapping: Optional dict mapping roles to CSV column names, e.g.
            {'asset_id': 'TN', 'asset_type': 'asset_type', 'x': 'Easting', 'y': 'Northing'}
        filename: Original filename for batch tracking

    Returns:
        dict with import results
    """
    mapping = {**DEFAULT_MAPPING, **(column_mapping or {})}

    # Read the CSV content
    content = csv_file.read()
    if isinstance(content, bytes):
        content = content.decode('utf-8-sig')  # Handle BOM if present

    reader = csv.DictReader(io.StringIO(content))

    # Validate that mapped columns exist in the CSV
    fieldnames = reader.fieldnames
    required_roles = ['asset_id', 'asset_type', 'x', 'y']
    missing = []
    for role in required_roles:
        col = mapping.get(role, '')
        if not col or col not in fieldnames:
            missing.append(f"{role} (mapped to '{col}')")
    if missing:
        raise ValueError(f"Missing columns in CSV: {', '.join(missing)}")

    # Build set of mapped column names to exclude from metadata
    mapped_columns = set(mapping.values())

    # Get or create asset types
    asset_types_cache = {at.name.lower(): at for at in AssetType.objects.all()}

    results = {
        'created': 0,
        'updated': 0,
        'errors': [],
        'assets': []
    }

    col_id = mapping['asset_id']
    col_type = mapping['asset_type']
    col_x = mapping['x']
    col_y = mapping['y']
    col_name = mapping.get('name', '')

    with transaction.atomic():
        # Create import batch for tracking
        batch_filename = filename or getattr(csv_file, 'name', 'unknown.csv')
        batch = ImportBatch.objects.create(
            project=project,
            filename=batch_filename,
            asset_count=0
        )

        for row_num, row in enumerate(reader, start=2):  # Start at 2 (1-indexed + header)
            try:
                # Extract fields using mapped column names
                asset_id = row.get(col_id, '').strip()
                asset_type_name = row.get(col_type, '').strip()
                x_str = row.get(col_x, '').strip()
                y_str = row.get(col_y, '').strip()

                if not asset_id:
                    results['errors'].append(f"Row {row_num}: Missing asset_id (column '{col_id}')")
                    continue

                if not asset_type_name:
                    results['errors'].append(f"Row {row_num}: Missing asset_type (column '{col_type}')")
                    continue

                # Parse coordinates
                try:
                    x = float(x_str)
                    y = float(y_str)
                except ValueError:
                    results['errors'].append(f"Row {row_num}: Invalid coordinates ({col_x}={x_str}, {col_y}={y_str})")
                    continue

                # Get or create asset type
                asset_type_key = asset_type_name.lower()
                if asset_type_key not in asset_types_cache:
                    # Create new asset type with defaults
                    asset_type = AssetType.objects.create(name=asset_type_name)
                    asset_types_cache[asset_type_key] = asset_type
                else:
                    asset_type = asset_types_cache[asset_type_key]

                # Build metadata from extra columns (not mapped to any role)
                metadata = {}
                for key, value in row.items():
                    if key not in mapped_columns and value:
                        metadata[key] = value

                # Get optional name
                name = row.get(col_name, '').strip() if col_name else ''

                # Create or update asset
                asset, created = Asset.objects.update_or_create(
                    project=project,
                    asset_id=asset_id,
                    defaults={
                        'asset_type': asset_type,
                        'name': name,
                        'original_x': x,
                        'original_y': y,
                        'metadata': metadata,
                        'import_batch': batch,
                    }
                )

                if created:
                    results['created'] += 1
                else:
                    results['updated'] += 1

                results['assets'].append({
                    'asset_id': asset_id,
                    'created': created,
                    'x': x,
                    'y': y
                })

            except Exception as e:
                results['errors'].append(f"Row {row_num}: {str(e)}")

        # Update batch asset count
        batch.asset_count = results['created'] + results['updated']
        batch.save(update_fields=['asset_count'])

    logger.info("CSV import for project %d: %d created, %d updated, %d errors",
                project.pk, results['created'], results['updated'], len(results['errors']))
    if results['errors']:
        logger.warning("CSV import errors: %s", results['errors'][:5])  # Log first 5

    return results
