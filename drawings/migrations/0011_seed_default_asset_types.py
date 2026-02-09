"""Seed default asset types for CSV import."""
from django.db import migrations


def seed_asset_types(apps, schema_editor):
    AssetType = apps.get_model('drawings', 'AssetType')
    defaults = [
        ('TN Intersection', 'circle', '#FF0000', 20),
        ('VSL', 'square', '#0066FF', 20),
        ('CCTV', 'triangle', '#00AA00', 20),
    ]
    for name, icon_shape, color, size in defaults:
        AssetType.objects.get_or_create(
            name=name,
            defaults={
                'icon_shape': icon_shape,
                'color': color,
                'size': size,
            }
        )


def remove_asset_types(apps, schema_editor):
    AssetType = apps.get_model('drawings', 'AssetType')
    AssetType.objects.filter(name__in=['TN Intersection', 'VSL', 'CCTV']).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0010_project_scale_calibrated_coord_unit'),
    ]

    operations = [
        migrations.RunPython(seed_asset_types, remove_asset_types),
    ]
