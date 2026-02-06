"""API URL configuration for drawings app."""
from django.urls import path
from . import api_views

urlpatterns = [
    # Projects
    path('projects/', api_views.ProjectListCreate.as_view(), name='project-list'),
    path('projects/<int:pk>/', api_views.ProjectDetail.as_view(), name='project-detail'),

    # Sheets
    path('projects/<int:project_pk>/sheets/', api_views.SheetListCreate.as_view(), name='sheet-list'),
    path('sheets/<int:pk>/', api_views.SheetDetail.as_view(), name='sheet-detail'),
    path('sheets/<int:pk>/render/', api_views.render_sheet, name='sheet-render'),
    path('sheets/<int:pk>/split/', api_views.split_sheet, name='sheet-split'),

    # Assets
    path('projects/<int:project_pk>/assets/', api_views.AssetListCreate.as_view(), name='asset-list'),
    path('assets/<int:pk>/', api_views.AssetDetail.as_view(), name='asset-detail'),
    path('assets/<int:pk>/adjust/', api_views.adjust_asset, name='asset-adjust'),

    # CSV Import
    path('projects/<int:project_pk>/import-csv/', api_views.import_csv, name='import-csv'),
    path('column-presets/', api_views.column_presets, name='column-presets'),

    # Import Batches
    path('projects/<int:project_pk>/import-batches/', api_views.import_batch_list, name='import-batch-list'),
    path('import-batches/<int:pk>/', api_views.import_batch_delete, name='import-batch-delete'),

    # Export
    path('projects/<int:project_pk>/export/', api_views.export_project, name='export-project'),
    path('projects/<int:project_pk>/adjustment-report/', api_views.adjustment_report, name='adjustment-report'),

    # Calibration
    path('projects/<int:pk>/calibrate/', api_views.calibrate_project, name='calibrate-project'),
]
