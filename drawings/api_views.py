"""API views for drawings app."""
import json
import math
import logging
from django.shortcuts import get_object_or_404
from django.http import JsonResponse, HttpResponse
from django.db import transaction
from rest_framework import generics, status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import Project, Sheet, Asset, AdjustmentLog, AssetType

logger = logging.getLogger(__name__)
from .serializers import (
    ProjectSerializer, ProjectListSerializer,
    SheetSerializer, AssetSerializer, AdjustmentLogSerializer
)
from .services.pdf_processor import render_pdf_page, get_pdf_page_count
from .services.csv_importer import import_assets_from_csv
from .services.export_service import export_sheet_with_overlays, generate_adjustment_report


class ProjectListCreate(generics.ListCreateAPIView):
    queryset = Project.objects.all()

    def get_serializer_class(self):
        if self.request.method == 'GET':
            return ProjectListSerializer
        return ProjectSerializer


class ProjectDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Project.objects.all()
    serializer_class = ProjectSerializer


class SheetListCreate(generics.ListCreateAPIView):
    serializer_class = SheetSerializer

    def get_queryset(self):
        return Sheet.objects.filter(project_id=self.kwargs['project_pk'])

    def create(self, request, *args, **kwargs):
        """
        Create sheet(s) from uploaded PDF.
        If the PDF has multiple pages, creates a sheet for each page with sequential naming.
        """
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        pdf_file = request.FILES.get('pdf_file')
        base_name = request.data.get('name', 'Sheet')

        if not pdf_file:
            return Response({'error': 'No PDF file provided'}, status=status.HTTP_400_BAD_REQUEST)

        # Save the file temporarily to get page count
        # First, create the initial sheet to save the file
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        first_sheet = serializer.save(project=project, page_number=1)

        # Get the page count from the saved PDF
        try:
            page_count = get_pdf_page_count(first_sheet.pdf_file.path)
        except Exception as e:
            # If we can't read the PDF, just render the first page
            render_pdf_page(first_sheet)
            return Response(self.get_serializer(first_sheet).data, status=status.HTTP_201_CREATED)

        created_sheets = []

        if page_count == 1:
            # Single page PDF - just render and return
            render_pdf_page(first_sheet)
            created_sheets.append(first_sheet)
        else:
            # Multi-page PDF - update first sheet name and create additional sheets
            # Format: name-01, name-02, etc.
            width = len(str(page_count))  # Determine padding width

            # Update first sheet with sequential name
            first_sheet.name = f"{base_name}-{str(1).zfill(width)}"
            first_sheet.save()
            render_pdf_page(first_sheet)
            created_sheets.append(first_sheet)

            # Create sheets for remaining pages
            for page_num in range(2, page_count + 1):
                sheet_name = f"{base_name}-{str(page_num).zfill(width)}"
                sheet = Sheet.objects.create(
                    project=project,
                    name=sheet_name,
                    pdf_file=first_sheet.pdf_file,  # Reuse the same PDF file
                    page_number=page_num
                )
                render_pdf_page(sheet)
                created_sheets.append(sheet)

        # Return all created sheets
        response_serializer = self.get_serializer(created_sheets, many=True)
        return Response(response_serializer.data, status=status.HTTP_201_CREATED)

    def perform_create(self, serializer):
        # This is kept for compatibility but create() now handles the logic
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        sheet = serializer.save(project=project)
        render_pdf_page(sheet)


class SheetDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Sheet.objects.all()
    serializer_class = SheetSerializer


@api_view(['POST'])
def render_sheet(request, pk):
    """Re-render a sheet's PDF to image."""
    sheet = get_object_or_404(Sheet, pk=pk)
    try:
        render_pdf_page(sheet)
        return Response({
            'status': 'success',
            'rendered_image': request.build_absolute_uri(sheet.rendered_image.url),
            'width': sheet.image_width,
            'height': sheet.image_height
        })
    except Exception as e:
        logger.error("Failed to render sheet %d: %s", pk, e)
        return Response({'status': 'error', 'message': str(e)}, status=500)


class AssetListCreate(generics.ListCreateAPIView):
    serializer_class = AssetSerializer

    def get_queryset(self):
        return Asset.objects.filter(project_id=self.kwargs['project_pk'])

    def perform_create(self, serializer):
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        serializer.save(project=project)


class AssetDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Asset.objects.all()
    serializer_class = AssetSerializer


@api_view(['POST'])
def adjust_asset(request, pk):
    """Adjust an asset's position and log the change."""
    asset = get_object_or_404(Asset, pk=pk)

    new_x = request.data.get('x')
    new_y = request.data.get('y')
    notes = request.data.get('notes', '')

    if new_x is None or new_y is None:
        return Response({'error': 'x and y coordinates required'}, status=400)

    # Get the "from" coordinates
    from_x = asset.current_x
    from_y = asset.current_y

    # Create adjustment log
    AdjustmentLog.objects.create(
        asset=asset,
        from_x=from_x,
        from_y=from_y,
        to_x=float(new_x),
        to_y=float(new_y),
        notes=notes
    )

    # Update asset
    asset.adjusted_x = float(new_x)
    asset.adjusted_y = float(new_y)
    asset.is_adjusted = True
    asset.save()

    serializer = AssetSerializer(asset)
    return Response(serializer.data)


@api_view(['POST'])
def import_csv(request, project_pk):
    """Import assets from CSV file."""
    project = get_object_or_404(Project, pk=project_pk)

    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=400)

    csv_file = request.FILES['file']
    try:
        result = import_assets_from_csv(project, csv_file)
        return Response(result)
    except Exception as e:
        logger.error("CSV import failed for project %d: %s", project_pk, e)
        return Response({'error': str(e)}, status=400)


@api_view(['POST'])
def export_project(request, project_pk):
    """Export sheets with asset overlays as PDFs."""
    project = get_object_or_404(Project, pk=project_pk)
    sheet_ids = request.data.get('sheet_ids', [])

    if not sheet_ids:
        sheets = project.sheets.all()
    else:
        sheets = project.sheets.filter(id__in=sheet_ids)

    try:
        results = []
        for sheet in sheets:
            output_path = export_sheet_with_overlays(sheet, project.assets.all())
            results.append({
                'sheet_id': sheet.id,
                'sheet_name': sheet.name,
                'output_path': output_path
            })
        logger.info("Exported %d sheet(s) for project %d", len(results), project_pk)
        return Response({'status': 'success', 'exports': results})
    except Exception as e:
        logger.error("Export failed for project %d: %s", project_pk, e)
        return Response({'error': str(e)}, status=500)


@api_view(['GET'])
def adjustment_report(request, project_pk):
    """Generate adjustment report for a project."""
    project = get_object_or_404(Project, pk=project_pk)
    format_type = request.query_params.get('format', 'json')

    adjusted_assets = project.assets.filter(is_adjusted=True)
    logs = AdjustmentLog.objects.filter(asset__project=project).order_by('-timestamp')

    if format_type == 'csv':
        return generate_adjustment_report(project, adjusted_assets, logs, format_type='csv')

    # JSON response
    report = {
        'project': project.name,
        'total_assets': project.assets.count(),
        'adjusted_count': adjusted_assets.count(),
        'adjustments': AdjustmentLogSerializer(logs, many=True).data,
        'summary': []
    }

    for asset in adjusted_assets:
        report['summary'].append({
            'asset_id': asset.asset_id,
            'name': asset.name,
            'original': {'x': asset.original_x, 'y': asset.original_y},
            'adjusted': {'x': asset.adjusted_x, 'y': asset.adjusted_y},
            'delta_distance': asset.delta_distance,
            'adjustment_count': asset.adjustment_logs.count()
        })

    return Response(report)


def _parse_finite_float(value, name):
    """Parse a value as a finite float, raising ValueError with a descriptive message."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"'{name}' must be a valid number, got: {value!r}")
    if not math.isfinite(result):
        raise ValueError(f"'{name}' must be a finite number, got: {result}")
    return result


@api_view(['POST'])
def calibrate_project(request, pk):
    """Set scale calibration for a project."""
    project = get_object_or_404(Project, pk=pk)

    # For scale calibration: provide two pixel points and the real-world distance
    pixel_distance = request.data.get('pixel_distance')
    real_distance = request.data.get('real_distance')  # in meters

    if pixel_distance is not None and real_distance is not None:
        try:
            pixel_distance = _parse_finite_float(pixel_distance, 'pixel_distance')
            real_distance = _parse_finite_float(real_distance, 'real_distance')
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

        if real_distance <= 0:
            return Response({'error': 'real_distance must be greater than 0'}, status=400)
        if pixel_distance <= 0:
            return Response({'error': 'pixel_distance must be greater than 0'}, status=400)

        project.pixels_per_meter = pixel_distance / real_distance
        logger.info("Project %d calibrated: %.2f px/m (pixel_dist=%.2f, real_dist=%.2f)",
                     project.pk, project.pixels_per_meter, pixel_distance, real_distance)

    # For origin setting
    origin_x = request.data.get('origin_x')
    origin_y = request.data.get('origin_y')

    try:
        if origin_x is not None:
            project.origin_x = _parse_finite_float(origin_x, 'origin_x')
        if origin_y is not None:
            project.origin_y = _parse_finite_float(origin_y, 'origin_y')
    except ValueError as e:
        return Response({'error': str(e)}, status=400)

    # For viewport rotation
    canvas_rotation = request.data.get('canvas_rotation')
    if canvas_rotation is not None:
        try:
            project.canvas_rotation = _parse_finite_float(canvas_rotation, 'canvas_rotation')
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

    # Asset layer calibration
    asset_rotation = request.data.get('asset_rotation')
    if asset_rotation is not None:
        try:
            project.asset_rotation = _parse_finite_float(asset_rotation, 'asset_rotation')
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

    ref_asset_id = request.data.get('ref_asset_id')
    if ref_asset_id is not None:
        project.ref_asset_id = str(ref_asset_id)[:100]

    try:
        ref_pixel_x = request.data.get('ref_pixel_x')
        ref_pixel_y = request.data.get('ref_pixel_y')
        if ref_pixel_x is not None:
            project.ref_pixel_x = _parse_finite_float(ref_pixel_x, 'ref_pixel_x')
        if ref_pixel_y is not None:
            project.ref_pixel_y = _parse_finite_float(ref_pixel_y, 'ref_pixel_y')
    except ValueError as e:
        return Response({'error': str(e)}, status=400)

    project.save()

    return Response({
        'pixels_per_meter': project.pixels_per_meter,
        'origin_x': project.origin_x,
        'origin_y': project.origin_y,
        'canvas_rotation': project.canvas_rotation,
        'asset_rotation': project.asset_rotation,
        'ref_asset_id': project.ref_asset_id,
        'ref_pixel_x': project.ref_pixel_x,
        'ref_pixel_y': project.ref_pixel_y,
    })


@api_view(['POST'])
def split_sheet(request, pk):
    """Split a sheet into two independent pieces along a line."""
    original = get_object_or_404(Sheet, pk=pk)

    p1 = request.data.get('p1')  # {x, y}
    p2 = request.data.get('p2')  # {x, y}

    if not p1 or not p2:
        return Response({'error': 'p1 and p2 coordinates required'}, status=400)

    # Validate p1 and p2 have numeric x,y keys
    try:
        p1_x = _parse_finite_float(p1.get('x'), 'p1.x')
        p1_y = _parse_finite_float(p1.get('y'), 'p1.y')
        p2_x = _parse_finite_float(p2.get('x'), 'p2.x')
        p2_y = _parse_finite_float(p2.get('y'), 'p2.y')
    except (ValueError, AttributeError) as e:
        return Response({'error': f'Invalid coordinates: {e}'}, status=400)

    cut_entry = {'p1': {'x': p1_x, 'y': p1_y}, 'p2': {'x': p2_x, 'y': p2_y}}

    try:
        with transaction.atomic():
            # Create new sheet (copy of original) with opposite cut
            new_sheet = Sheet.objects.create(
                project=original.project,
                name=f"{original.name}-split",
                pdf_file=original.pdf_file,
                page_number=original.page_number,
                offset_x=original.offset_x,
                offset_y=original.offset_y,
                rotation=original.rotation,
                z_index=original.z_index + 1,
                cuts_json=[{**cut_entry, 'flipped': True}],
            )

            # Render the new sheet's image
            render_pdf_page(new_sheet)

            # Append cut to original sheet's existing cuts
            original_cuts = list(original.cuts_json or [])
            original_cuts.append({**cut_entry, 'flipped': False})
            original.cuts_json = original_cuts
            original.save()

        logger.info("Sheet %d split into %d and %d", original.pk, original.pk, new_sheet.pk)
    except Exception as e:
        logger.error("Failed to split sheet %d: %s", pk, e)
        return Response({'error': f'Split failed: {e}'}, status=500)

    return Response({
        'original_id': original.id,
        'new_sheet': SheetSerializer(new_sheet, context={'request': request}).data
    })
