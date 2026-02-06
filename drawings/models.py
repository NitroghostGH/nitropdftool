"""Models for the PDF alignment and asset overlay system."""
import math
from django.db import models
from .validators import PDFFileValidator, ImageFileValidator


class Project(models.Model):
    """A project containing multiple sheets and assets."""
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Coordinate system calibration
    pixels_per_meter = models.FloatField(default=100.0, help_text="Scale factor from pixels to meters")
    origin_x = models.FloatField(default=0.0, help_text="X coordinate of origin in pixels")
    origin_y = models.FloatField(default=0.0, help_text="Y coordinate of origin in pixels")

    # Viewport rotation (for aligning drawings with different orientations)
    canvas_rotation = models.FloatField(default=0.0, help_text="Viewport rotation in degrees")

    # Asset layer calibration (independent of viewport)
    asset_rotation = models.FloatField(default=0.0, help_text="Asset layer rotation in degrees")
    ref_asset_id = models.CharField(max_length=100, blank=True, default='', help_text="Asset ID of the reference point asset")
    ref_pixel_x = models.FloatField(default=0.0, help_text="Pixel X where reference asset was placed on canvas")
    ref_pixel_y = models.FloatField(default=0.0, help_text="Pixel Y where reference asset was placed on canvas")

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class Sheet(models.Model):
    """A single PDF page/sheet within a project."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='sheets')
    name = models.CharField(max_length=255)
    pdf_file = models.FileField(
        upload_to='pdfs/',
        validators=[PDFFileValidator(max_size=50 * 1024 * 1024)]  # 50 MB max
    )
    page_number = models.PositiveIntegerField(default=1, help_text="Page number within the PDF")

    # Rendered image cache
    rendered_image = models.ImageField(upload_to='rendered/', blank=True, null=True)
    image_width = models.PositiveIntegerField(default=0)
    image_height = models.PositiveIntegerField(default=0)

    # Cut lines (array of {p1: {x, y}, p2: {x, y}, flipped: bool})
    cuts_json = models.JSONField(default=list, blank=True,
        help_text="Array of cut definitions: [{p1: {x, y}, p2: {x, y}, flipped: bool}, ...]")

    # Position offset for alignment
    offset_x = models.FloatField(default=0.0, help_text="X offset in pixels")
    offset_y = models.FloatField(default=0.0, help_text="Y offset in pixels")
    rotation = models.FloatField(default=0.0, help_text="Rotation in degrees")
    z_index = models.IntegerField(default=0, help_text="Layer order (higher = on top)")

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['z_index', 'name']

    def __str__(self):
        return f"{self.name} (Page {self.page_number})"

    def delete(self, *args, **kwargs):
        pdf_path = self.pdf_file.name if self.pdf_file else None
        rendered_path = self.rendered_image.name if self.rendered_image else None

        # Check if other sheets share the same PDF file
        other_pdf_users = 0
        if pdf_path:
            other_pdf_users = Sheet.objects.filter(pdf_file=pdf_path).exclude(pk=self.pk).count()

        # Delete the DB record (without auto-deleting the file)
        super().delete(*args, **kwargs)

        # Only delete files if no other sheets reference them
        if pdf_path and other_pdf_users == 0:
            self.pdf_file.storage.delete(pdf_path)
        if rendered_path:
            self.rendered_image.storage.delete(rendered_path)


class JoinMark(models.Model):
    """A join mark on a sheet that references another sheet."""
    sheet = models.ForeignKey(Sheet, on_delete=models.CASCADE, related_name='join_marks')

    # Position on sheet (in pixels)
    x = models.FloatField()
    y = models.FloatField()

    # Reference label (e.g., "JOIN TO SHEET B-3")
    reference_label = models.CharField(max_length=255)

    # Link to the matching join mark on another sheet
    linked_mark = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='linked_from'
    )

    def __str__(self):
        return f"{self.reference_label} at ({self.x}, {self.y})"


class AssetType(models.Model):
    """Configurable asset type with icon settings (editable in Django admin)."""
    ICON_CHOICES = [
        ('circle', 'Circle'),
        ('square', 'Square'),
        ('triangle', 'Triangle'),
        ('star', 'Star'),
        ('diamond', 'Diamond'),
        ('custom', 'Custom Image'),
    ]

    name = models.CharField(max_length=100, unique=True)
    icon_shape = models.CharField(max_length=20, choices=ICON_CHOICES, default='circle')
    custom_icon = models.ImageField(
        upload_to='icons/',
        blank=True,
        null=True,
        help_text="Custom icon image (PNG/JPG)",
        validators=[ImageFileValidator(max_size=5 * 1024 * 1024)]  # 5 MB max
    )
    color = models.CharField(max_length=7, default='#FF0000', help_text="Hex color code")
    size = models.PositiveIntegerField(default=20, help_text="Icon size in pixels")

    class Meta:
        verbose_name = "Asset Type"
        verbose_name_plural = "Asset Types"

    def __str__(self):
        return self.name


class ImportBatch(models.Model):
    """A batch of assets imported from a single CSV file."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='import_batches')
    filename = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    asset_count = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.filename} ({self.asset_count} assets)"


class Asset(models.Model):
    """An asset with coordinates to be plotted on the drawing."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='assets')
    asset_type = models.ForeignKey(AssetType, on_delete=models.PROTECT, related_name='assets')
    import_batch = models.ForeignKey('ImportBatch', on_delete=models.SET_NULL, null=True, blank=True, related_name='assets')

    # Identifier from source data
    asset_id = models.CharField(max_length=100)
    name = models.CharField(max_length=255, blank=True)

    # Original coordinates from data source (in meters)
    original_x = models.FloatField()
    original_y = models.FloatField()

    # Adjusted coordinates after manual correction (in meters)
    adjusted_x = models.FloatField(null=True, blank=True)
    adjusted_y = models.FloatField(null=True, blank=True)

    # Flag to track if asset has been manually adjusted
    is_adjusted = models.BooleanField(default=False)

    # Additional metadata from CSV
    metadata = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['asset_id']
        unique_together = ['project', 'asset_id']

    def __str__(self):
        return f"{self.asset_id} - {self.name}"

    @property
    def current_x(self):
        """Return adjusted X if available, otherwise original."""
        return self.adjusted_x if self.is_adjusted else self.original_x

    @property
    def current_y(self):
        """Return adjusted Y if available, otherwise original."""
        return self.adjusted_y if self.is_adjusted else self.original_y

    @property
    def delta_distance(self):
        """Calculate the distance between original and adjusted positions."""
        if not self.is_adjusted:
            return 0.0
        dx = self.adjusted_x - self.original_x
        dy = self.adjusted_y - self.original_y
        return math.sqrt(dx * dx + dy * dy)


class AdjustmentLog(models.Model):
    """Log of manual adjustments made to assets."""
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name='adjustment_logs')

    # Coordinates before adjustment (in meters)
    from_x = models.FloatField()
    from_y = models.FloatField()

    # Coordinates after adjustment (in meters)
    to_x = models.FloatField()
    to_y = models.FloatField()

    # Calculated deltas
    delta_x = models.FloatField()
    delta_y = models.FloatField()
    delta_distance = models.FloatField()

    # Metadata
    timestamp = models.DateTimeField(auto_now_add=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ['-timestamp']

    def __str__(self):
        return f"{self.asset.asset_id} adjusted {self.delta_distance:.2f}m on {self.timestamp}"

    def save(self, *args, **kwargs):
        # Calculate deltas before saving
        self.delta_x = self.to_x - self.from_x
        self.delta_y = self.to_y - self.from_y
        self.delta_distance = math.sqrt(self.delta_x ** 2 + self.delta_y ** 2)
        super().save(*args, **kwargs)


class ColumnPreset(models.Model):
    """Admin-managed mapping of known CSV column names to import roles."""
    ROLE_CHOICES = [
        ('asset_id', 'Asset ID'),
        ('asset_type', 'Asset Type'),
        ('x', 'X Coordinate'),
        ('y', 'Y Coordinate'),
        ('name', 'Name (optional)'),
    ]

    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    column_name = models.CharField(max_length=100, help_text="CSV column header that maps to this role")
    priority = models.IntegerField(default=0, help_text="Higher = preferred when multiple matches")

    class Meta:
        ordering = ['role', '-priority']
        unique_together = ['role', 'column_name']
        verbose_name = "Column Preset"
        verbose_name_plural = "Column Presets"

    def __str__(self):
        return f"{self.column_name} \u2192 {self.get_role_display()}"
