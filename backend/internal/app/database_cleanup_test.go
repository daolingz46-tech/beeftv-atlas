package app

import (
	"testing"

	"gorm.io/gorm"
)

func closeTestDatabaseOnCleanup(t *testing.T, db *gorm.DB) {
	t.Helper()
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := pool.Close(); err != nil {
			t.Errorf("close test database: %v", err)
		}
	})
}
