"""Custom permissions for the drawings app."""
from django.conf import settings
from rest_framework.permissions import BasePermission, IsAuthenticated


class IsAuthenticatedOrDebug(BasePermission):
    """
    Allow access if:
    - User is authenticated, OR
    - DEBUG mode is enabled (for local development)

    In production (DEBUG=False), authentication is required.
    """

    def has_permission(self, request, view):
        if settings.DEBUG:
            return True
        return request.user and request.user.is_authenticated
