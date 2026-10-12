package task

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/repository"
)

func TestScopeAdmissionReasonsRemainLocalWithoutExposingRepositoryErrors(t *testing.T) {
	for _, tc := range []struct {
		cause  error
		reason kernel.ErrorReason
	}{{repository.ErrTaskScopeNotActive, TaskScopeUnavailableReason}, {repository.ErrTaskScopeArchived, TaskScopeArchivedReason}} {
		failure := mapTaskScopeError(tc.cause)
		var appErr *kernel.AppError
		if !errors.As(failure, &appErr) || appErr.Status != 400 || appErr.Reason != tc.reason || appErr.Retryable || appErr.Cause != nil || errors.Is(failure, tc.cause) {
			t.Fatalf("incorrect local scope admission failure: %#v", failure)
		}
	}
}
