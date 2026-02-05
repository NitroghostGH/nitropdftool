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

    # Crop region (for manual cutting)
    crop_x = models.FloatField(default=0.0)
    crop_y = models.FloatField(default=0.0)
    crop_width = models.FloatField(default=0.0, help_text="0 means full width")
    crop_height = models.FloatField(default=0.0, help_text="0 means full height")

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


class Asset(models.Model):
    """An asset with coordinates to be plotted on the drawing."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='assets')
    asset_type = models.ForeignKey(AssetType, on_delete=models.PROTECT, related_name='assets')

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
