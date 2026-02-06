"""DRF Serializers for drawings app."""
from rest_framework import serializers
from .models import Project, Sheet, JoinMark, AssetType, Asset, AdjustmentLog


class AssetTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = AssetType
        fields = ['id', 'name', 'icon_shape', 'custom_icon', 'color', 'size']


class JoinMarkSerializer(serializers.ModelSerializer):
    class Meta:
        model = JoinMark
        fields = ['id', 'sheet', 'x', 'y', 'reference_label', 'linked_mark']


class SheetSerializer(serializers.ModelSerializer):
    join_marks = JoinMarkSerializer(many=True, read_only=True)
    rendered_image_url = serializers.SerializerMethodField()

    class Meta:
        model = Sheet
        fields = [
            'id', 'project', 'name', 'pdf_file', 'page_number',
            'rendered_image', 'rendered_image_url', 'image_width', 'image_height',
            'crop_x', 'crop_y', 'crop_width', 'crop_height', 'crop_flipped',
            'offset_x', 'offset_y', 'rotation', 'z_index',
            'join_marks', 'created_at'
        ]
        read_only_fields = ['project', 'rendered_image', 'image_width', 'image_height']

    def get_rendered_image_url(self, obj):
        if obj.rendered_image:
            request = self.context.get('request')
            if request:
                return request.build_absolute_uri(obj.rendered_image.url)
            return obj.rendered_image.url
        return None


class AssetSerializer(serializers.ModelSerializer):
    asset_type_data = AssetTypeSerializer(source='asset_type', read_only=True)
    current_x = serializers.FloatField(read_only=True)
    current_y = serializers.FloatField(read_only=True)
    delta_distance = serializers.FloatField(read_only=True)

    class Meta:
        model = Asset
        fields = [
            'id', 'project', 'asset_type', 'asset_type_data', 'asset_id', 'name',
            'original_x', 'original_y', 'adjusted_x', 'adjusted_y',
            'current_x', 'current_y', 'is_adjusted', 'delta_distance',
            'metadata', 'created_at', 'updated_at'
        ]
        read_only_fields = ['project', 'is_adjusted']


class AdjustmentLogSerializer(serializers.ModelSerializer):
    asset_id = serializers.CharField(source='asset.asset_id', read_only=True)

    class Meta:
        model = AdjustmentLog
        fields = [
            'id', 'asset', 'asset_id',
            'from_x', 'from_y', 'to_x', 'to_y',
            'delta_x', 'delta_y', 'delta_distance',
            'timestamp', 'notes'
        ]
        read_only_fields = ['delta_x', 'delta_y', 'delta_distance']


class ProjectSerializer(serializers.ModelSerializer):
    sheets = SheetSerializer(many=True, read_only=True)
    asset_count = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = [
            'id', 'name', 'description',
            'pixels_per_meter', 'origin_x', 'origin_y', 'canvas_rotation',
            'sheets', 'asset_count',
            'created_at', 'updated_at'
        ]

    def get_asset_count(self, obj):
        return obj.assets.count()


class ProjectListSerializer(serializers.ModelSerializer):
    """Lighter serializer for list views."""
    sheet_count = serializers.SerializerMethodField()
    asset_count = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = ['id', 'name', 'description', 'sheet_count', 'asset_count', 'created_at']

    def get_sheet_count(self, obj):
        return obj.sheets.count()

    def get_asset_count(self, obj):
        return obj.assets.count()
