package handler

import (
	"testing"

	"gorm.io/gorm"
)

// Windows keeps SQLite files locked until the connection pool is closed.
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
